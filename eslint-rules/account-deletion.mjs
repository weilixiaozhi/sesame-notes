/** 限制业务直接取得User删除委托，避免绕过账号历史身份清理用例。 */
export default {
  meta: {
    type: 'problem',
    schema: [],
    messages: { bypass: '账号删除必须通过 accounts 的 deleteAccount 用例处理共享身份和同步历史。' },
  },
  create(context) {
    return {
      'MemberExpression[object.type="MemberExpression"]:matches([object.computed=false][object.property.name="user"], [object.computed=true][object.property.value="user"]):matches([computed=false][property.name=/^(delete|deleteMany)$/], [computed=true][property.value=/^(delete|deleteMany)$/])':
        function (node) {
          context.report({ node, messageId: 'bypass' });
        },
    };
  },
};
