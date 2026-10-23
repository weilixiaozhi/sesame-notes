const METHODS = ['get', 'post', 'put', 'patch', 'delete', 'head', 'options'];
const ANNOTATIONS = new Set([
  'description',
  'summary',
  'title',
  'example',
  'examples',
  'externalDocs',
  'deprecated',
  '$id',
]);

/** 安全数组是候选方案的 OR，每个方案中的认证方式和 scope 为 AND；新要求必须接受全部旧方案。 */
function acceptsPreviousSecurity(previous, candidate) {
  try {
    /** 空安全数组与空要求对象均允许匿名访问，不能误判为新增认证。 */
    function alternatives(requirements) {
      if (!Array.isArray(requirements)) throw new Error('security 必须为认证要求数组');
      for (const requirement of requirements) {
        if (
          !requirement ||
          typeof requirement !== 'object' ||
          Array.isArray(requirement) ||
          Object.values(requirement).some(
            (scopes) => !Array.isArray(scopes) || scopes.some((scope) => typeof scope !== 'string'),
          )
        ) {
          throw new Error('security 认证要求或scope格式无效');
        }
      }
      return requirements.length ? requirements : [{}];
    }
    const oldAlternatives = alternatives(previous);
    const newAlternatives = alternatives(candidate);
    return oldAlternatives.every((old) =>
      newAlternatives.some((next) =>
        Object.entries(next).every(
          ([scheme, scopes]) => Object.hasOwn(old, scheme) && scopes.every((scope) => old[scheme].includes(scope)),
        ),
      ),
    );
  } catch (cause) {
    throw new Error('认证兼容性无法证明，请检查security声明', { cause });
  }
}

/** 固定对象键顺序；字段名也可能叫description，不能递归删除同名业务属性。 */
function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, stable(value[key])]),
    );
  }
  return value;
}

/** 展开当前文档内引用；未知引用和外部引用必须阻断，不能默认为兼容。 */
function dereference(value, document) {
  const seen = new Set();
  while (value?.$ref) {
    const ref = value.$ref;
    if (!ref.startsWith('#/') || seen.has(ref)) throw new Error(`无法解析契约引用：${ref}`);
    seen.add(ref);
    const resolved = ref
      .slice(2)
      .split('/')
      .reduce((node, key) => {
        const property = key.replaceAll('~1', '/').replaceAll('~0', '~');
        // JSON Pointer 只能遍历文档实际声明的节点，原型属性不构成有效引用。
        return node && Object.hasOwn(node, property) ? node[property] : undefined;
      }, document);
    if (!resolved) throw new Error(`契约引用不存在：${ref}`);
    const { $ref: _ref, ...siblings } = value;
    value = { ...resolved, ...siblings };
  }
  return value ?? {};
}

/** 判断一个取值集合是否包含于另一个，分别用于请求放宽与响应收紧。 */
function subsetProblems(subInput, superInput, subDocument, superDocument, path, visited = new Set()) {
  const sub = dereference(subInput, subDocument);
  const sup = dereference(superInput, superDocument);
  const identity = `${JSON.stringify(stable(sub))}|${JSON.stringify(stable(sup))}`;
  if (visited.has(identity)) return [];
  const nextVisited = new Set(visited).add(identity);
  const problems = [];
  const fail = (reason) => problems.push(`${path}: ${reason}`);
  const nested = (a, b, suffix) => subsetProblems(a, b, subDocument, superDocument, `${path}${suffix}`, nextVisited);
  const alternatives = (schema) => {
    const branches = schema.anyOf ?? schema.oneOf;
    return branches && schema.nullable ? [...branches, { type: 'null' }] : branches;
  };
  if (alternatives(sub) || alternatives(sup)) {
    // 联合外层仍可声明范围约束，不能因处理分支而漏掉新增的必填或长度限制。
    const common = (schema) =>
      alternatives(schema)
        ? Object.fromEntries(Object.entries(schema).filter(([key]) => !['anyOf', 'oneOf', 'nullable'].includes(key)))
        : {};
    problems.push(...nested(common(sub), common(sup), '.unionConstraints'));
    // 每个旧请求分支必须仍可发送，每个新响应分支必须仍可被旧客户端接收。
    for (const branch of alternatives(sub) ?? [sub]) {
      if (!(alternatives(sup) ?? [sup]).some((target) => nested(branch, target, '.union').length === 0))
        fail('联合类型出现无法兼容的分支');
    }
    // oneOf 的互斥语义不能仅按 anyOf 的并集推断。
    if ((sub.oneOf || sup.oneOf) && JSON.stringify(stable(sub)) !== JSON.stringify(stable(sup)))
      fail('oneOf 变更需要显式发布新主版本');
    return problems;
  }
  const types = (schema) =>
    new Set([
      ...(Array.isArray(schema.type) ? schema.type : schema.type ? [schema.type] : []),
      ...(schema.nullable ? ['null'] : []),
    ]);
  const subTypes = types(sub);
  const superTypes = types(sup);
  if (
    superTypes.size &&
    (!subTypes.size ||
      [...subTypes].some((type) => !superTypes.has(type) && !(type === 'integer' && superTypes.has('number'))))
  )
    fail('类型或可空范围不兼容');
  if (
    sup.enum &&
    (!sub.enum ||
      sub.enum.some((value) => !sup.enum.some((allowed) => JSON.stringify(value) === JSON.stringify(allowed))))
  )
    fail('枚举取值范围不兼容');
  for (const key of ['minimum', 'minLength', 'minItems', 'minProperties']) {
    if (sup[key] !== undefined && (sub[key] === undefined || sub[key] < sup[key])) fail(`${key} 收紧了可接受范围`);
  }
  for (const key of ['maximum', 'maxLength', 'maxItems', 'maxProperties']) {
    if (sup[key] !== undefined && (sub[key] === undefined || sub[key] > sup[key])) fail(`${key} 收紧了可接受范围`);
  }
  for (const key of [
    'pattern',
    'format',
    'multipleOf',
    'exclusiveMinimum',
    'exclusiveMaximum',
    'uniqueItems',
    'readOnly',
    'writeOnly',
    'discriminator',
  ]) {
    if (sup[key] !== undefined && JSON.stringify(stable(sub[key])) !== JSON.stringify(stable(sup[key])))
      fail(`${key} 约束无法证明兼容`);
  }
  const required = new Set(sub.required ?? []);
  for (const key of sup.required ?? []) if (!required.has(key)) fail(`缺少必需字段 ${key}`);
  for (const key of new Set([...Object.keys(sub.properties ?? {}), ...Object.keys(sup.properties ?? {})])) {
    // 字段可使用任意 JSON 名称；未声明字段必须按 additionalProperties 判定，不能继承 Object 原型。
    const a = Object.hasOwn(sub.properties ?? {}, key) ? sub.properties[key] : sub.additionalProperties;
    const b = Object.hasOwn(sup.properties ?? {}, key) ? sup.properties[key] : sup.additionalProperties;
    if (a === false) continue;
    if (b === false) {
      fail(`字段 ${key} 被禁止`);
      continue;
    }
    if (b && typeof b === 'object')
      problems.push(...nested(a && typeof a === 'object' ? a : {}, b, `.properties.${key}`));
  }
  if (sup.additionalProperties === false && sub.additionalProperties !== false) fail('额外字段范围不兼容');
  if (sup.additionalProperties && typeof sup.additionalProperties === 'object' && sub.additionalProperties !== false) {
    problems.push(
      ...nested(
        typeof sub.additionalProperties === 'object' ? sub.additionalProperties : {},
        sup.additionalProperties,
        '.additionalProperties',
      ),
    );
  }
  if (sup.items) problems.push(...nested(sub.items ?? {}, sup.items, '.items'));
  const known = new Set([
    'type',
    'nullable',
    'enum',
    'required',
    'properties',
    'additionalProperties',
    'items',
    'minimum',
    'maximum',
    'minLength',
    'maxLength',
    'minItems',
    'maxItems',
    'minProperties',
    'maxProperties',
    'pattern',
    'format',
    'multipleOf',
    'exclusiveMinimum',
    'exclusiveMaximum',
    'uniqueItems',
    'readOnly',
    'writeOnly',
    'discriminator',
    ...ANNOTATIONS,
  ]);
  for (const key of new Set([...Object.keys(sub), ...Object.keys(sup)])) {
    if (!known.has(key) && JSON.stringify(stable(sub[key])) !== JSON.stringify(stable(sup[key])))
      fail(`未支持的 ${key} 语义发生变化，需人工评审并发布新主版本`);
    if (key === 'allOf' && sub[key] && sup[key]) {
      for (let index = 0; index < sub[key].length; index++)
        problems.push(...nested(sub[key][index], sup[key][index] ?? {}, `.allOf.${index}`));
    }
  }
  return problems;
}

/** 比较发布基线与候选文档，保持旧请求可发送、旧响应可消费。 */
export function findContractBreakingChanges(baseline, candidate) {
  try {
    const problems = [];
    for (const [name, scheme] of Object.entries(baseline.components?.securitySchemes ?? {})) {
      if (JSON.stringify(stable(scheme)) !== JSON.stringify(stable(candidate.components?.securitySchemes?.[name]))) {
        problems.push(`securitySchemes.${name}: 已有认证方式变化需显式评审`);
      }
    }
    const compareSchema = (oldSchema, newSchema, direction, path) => {
      const args =
        direction === 'request'
          ? [oldSchema, newSchema, baseline, candidate]
          : [newSchema, oldSchema, candidate, baseline];
      problems.push(...subsetProblems(...args, path));
    };
    for (const [path, oldPathInput] of Object.entries(baseline.paths ?? {})) {
      const oldPath = dereference(oldPathInput, baseline);
      const newPath = dereference(candidate.paths?.[path], candidate);
      for (const method of METHODS) {
        if (!oldPath[method]) continue;
        const label = `${method.toUpperCase()} ${path}`;
        const oldOperation = dereference(oldPath[method], baseline);
        const newOperation = dereference(newPath[method], candidate);
        if (!newPath[method]) {
          problems.push(`${label}: 操作被删除`);
          continue;
        }
        if (oldOperation.operationId !== newOperation.operationId) problems.push(`${label}: operationId 改变`);
        const oldSecurity = oldOperation.security ?? baseline.security ?? [];
        const newSecurity = newOperation.security ?? candidate.security ?? [];
        if (!acceptsPreviousSecurity(oldSecurity, newSecurity))
          problems.push(`${label}: 安全要求收紧，旧客户端的认证方式或scope不再满足`);
        const parameters = (operation, pathItem, doc) =>
          new Map(
            [...(pathItem.parameters ?? []), ...(operation.parameters ?? [])].map((input) => {
              const parameter = dereference(input, doc);
              return [`${parameter.in}:${parameter.name}`, parameter];
            }),
          );
        const oldParameters = parameters(oldOperation, oldPath, baseline);
        const newParameters = parameters(newOperation, newPath, candidate);
        for (const [key, oldParameter] of oldParameters) {
          const newParameter = newParameters.get(key);
          if (!newParameter) {
            problems.push(`${label}: 参数 ${key} 被删除`);
            continue;
          }
          if (!oldParameter.required && newParameter.required) problems.push(`${label}: 参数 ${key} 改为必填`);
          for (const attribute of ['style', 'explode', 'allowReserved'])
            if (oldParameter[attribute] !== newParameter[attribute]) problems.push(`${label}: 参数 ${key} 编码变化`);
          const oldContent = oldParameter.content;
          const newContent = newParameter.content;
          if (oldContent || newContent) {
            // 参数的 schema 与 content 是不同的编码约定，不能用两个缺省空 schema 推断兼容。
            if (!oldContent || !newContent || oldParameter.schema || newParameter.schema) {
              problems.push(`${label}: 参数 ${key} 的 schema/content 编码约定变化或同时存在`);
              continue;
            }
            if (Object.keys(oldContent).length !== 1 || Object.keys(newContent).length !== 1) {
              throw new Error(`${label}: 参数 ${key} 的 content 必须恰有一种媒体类型`);
            }
            for (const [media, oldMedia] of Object.entries(oldContent)) {
              const newMedia = newContent[media];
              if (!newMedia) problems.push(`${label}: 参数 ${key} 媒体类型 ${media} 被删除`);
              else {
                compareSchema(
                  oldMedia.schema ?? {},
                  newMedia.schema ?? {},
                  'request',
                  `${label}.${key}.content.${media}`,
                );
                if (JSON.stringify(stable(oldMedia.encoding)) !== JSON.stringify(stable(newMedia.encoding))) {
                  problems.push(`${label}: 参数 ${key} 媒体编码变化需显式评审`);
                }
              }
            }
          } else {
            compareSchema(oldParameter.schema ?? {}, newParameter.schema ?? {}, 'request', `${label}.${key}`);
          }
        }
        for (const [key, parameter] of newParameters)
          if (parameter.required && !oldParameters.has(key)) problems.push(`${label}: 新增必填参数 ${key}`);
        const oldBody = dereference(oldOperation.requestBody, baseline);
        const newBody = dereference(newOperation.requestBody, candidate);
        if (!oldBody.required && newBody.required) problems.push(`${label}: 请求体改为必填`);
        for (const [media, oldContent] of Object.entries(oldBody.content ?? {})) {
          const newContent = newBody.content?.[media];
          if (!newContent) problems.push(`${label}: 请求媒体类型 ${media} 被删除`);
          else compareSchema(oldContent.schema ?? {}, newContent.schema ?? {}, 'request', `${label}.request.${media}`);
        }
        for (const [status, oldResponseInput] of Object.entries(oldOperation.responses ?? {})) {
          if (!newOperation.responses?.[status]) {
            problems.push(`${label}: 响应 ${status} 被删除`);
            continue;
          }
          const oldResponse = dereference(oldResponseInput, baseline);
          const newResponse = dereference(newOperation.responses[status], candidate);
          for (const [media, oldContent] of Object.entries(oldResponse.content ?? {})) {
            const newContent = newResponse.content?.[media];
            if (!newContent) problems.push(`${label}: 响应 ${status}/${media} 被删除`);
            else
              compareSchema(
                oldContent.schema ?? {},
                newContent.schema ?? {},
                'response',
                `${label}.response.${status}.${media}`,
              );
          }
          for (const [header, oldHeader] of Object.entries(oldResponse.headers ?? {})) {
            if (!newResponse.headers?.[header]) problems.push(`${label}: 响应头 ${header} 被删除`);
            else
              compareSchema(
                dereference(oldHeader, baseline).schema ?? {},
                dereference(newResponse.headers[header], candidate).schema ?? {},
                'response',
                `${label}.header.${header}`,
              );
          }
        }
        for (const status of Object.keys(newOperation.responses ?? {})) {
          if (status.startsWith('2') && !oldOperation.responses?.[status] && !oldOperation.responses?.default) {
            problems.push(`${label}: 新增成功状态 ${status}，旧客户端没有成功响应约定`);
          }
        }
      }
    }
    return [...new Set(problems)];
  } catch (cause) {
    throw new Error('历史契约兼容性分析失败', { cause });
  }
}
