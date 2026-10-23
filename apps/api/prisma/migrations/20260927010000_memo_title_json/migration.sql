BEGIN;

-- 标题使用 JSON 字符串承载原始字符，文本整体编码避免解释字面反斜杠转义。
ALTER TABLE "memo_entries"
  ALTER COLUMN "title" TYPE JSON USING to_json("title");

-- 标题只允许 JSON 字符串，正文的对象结构由独立约束校验。
ALTER TABLE "memo_entries" ADD CONSTRAINT "memo_entries_title_string_check"
  CHECK (json_typeof("title") = 'string');

COMMIT;
