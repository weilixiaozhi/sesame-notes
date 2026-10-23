/** 交易首次物化只能经过领域创建操作，确保分摊与同步事件同事务写入。 */
export default {
  meta: {
    type: 'problem',
    schema: [],
    messages: { bypass: '交易创建必须通过 accounting 的统一创建操作，原子写入交易、分摊和同步事件。' },
  },
  /** 检查直接调用、可选链和方法引用，避免提取写委托后绕过创建边界。 */
  create(context) {
    return {
      'MemberExpression[object.type="MemberExpression"]:matches([object.computed=false][object.property.name="transaction"], [object.computed=true][object.property.value="transaction"]):matches([computed=false][property.name=/^(create|createMany|createManyAndReturn|upsert)$/], [computed=true][property.value=/^(create|createMany|createManyAndReturn|upsert)$/])':
        /** 对账务交易的创建委托引用给出明确的领域入口。 */
        function (node) {
          context.report({ node, messageId: 'bypass' });
        },
    };
  },
};
