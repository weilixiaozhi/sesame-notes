import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { inflateRawSync } from 'node:zlib';
import ExcelJS from 'exceljs';
import type { Download, TestInfo } from '@playwright/test';
import { unwrap } from '@sesame-notes/api-client';
import type { MemoImportDocument } from '../src/features/memos/memo-import-format';
import { test, expect, login, peerClient } from './fixtures';
import { ensureRecordingStarted, openBookManagement } from './recording-start';

/** 保存浏览器实际下载结果作为证据，不凭点击成功判断导出完成。 */
async function downloaded(download: Download, testInfo: TestInfo) {
  const path = testInfo.outputPath(download.suggestedFilename());
  await download.saveAs(path);
  expect(await download.failure()).toBeNull();
  await testInfo.attach(download.suggestedFilename(), { path });
  return readFile(path);
}

/** 从本次生成的 Word ZIP 读取正文，验证真实中文内容与格式结构。 */
function wordDocument(buffer: Buffer): string {
  const end = buffer.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  expect(end).toBeGreaterThanOrEqual(0);
  let cursor = buffer.readUInt32LE(end + 16);
  for (let remaining = buffer.readUInt16LE(end + 10); remaining > 0; remaining--) {
    expect(buffer.readUInt32LE(cursor)).toBe(0x02014b50);
    const nameLength = buffer.readUInt16LE(cursor + 28);
    const extraLength = buffer.readUInt16LE(cursor + 30);
    const commentLength = buffer.readUInt16LE(cursor + 32);
    const name = buffer.subarray(cursor + 46, cursor + 46 + nameLength).toString();
    if (name === 'word/document.xml') {
      const local = buffer.readUInt32LE(cursor + 42);
      const start = local + 30 + buffer.readUInt16LE(local + 26) + buffer.readUInt16LE(local + 28);
      const compressed = buffer.subarray(start, start + buffer.readUInt32LE(cursor + 20));
      const method = buffer.readUInt16LE(cursor + 10);
      expect([0, 8]).toContain(method);
      return (method === 8 ? inflateRawSync(compressed, { maxOutputLength: 2_000_000 }) : compressed).toString();
    }
    cursor += 46 + nameLength + extraLength + commentLength;
  }
  throw new Error('下载的 Word 文件缺少正文');
}

test('JSON 导入新副本与重复跳过，真实下载 JSON、Markdown、Word、PNG 和打印 PDF', async ({
  page,
  account,
}, testInfo) => {
  test.setTimeout(120_000);
  const peer = await peerClient(account);
  await login(page, account);
  await page.goto('/memos');
  await ensureRecordingStarted(page, 'memos');
  await openBookManagement(page, 'memos');
  await page.getByRole('button', { name: '新建本子', exact: true }).click();
  await page.getByRole('dialog').getByLabel('名称', { exact: true }).fill('文件交换验收');
  await page.getByRole('button', { name: '保存本子', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  const book = unwrap(await peer.client.GET('/api/v1/sync/memo-books')).memo_books.find(
    (item) => item.name === '文件交换验收',
  )!;
  const sourceBook = randomUUID();
  const sourceEntry = randomUUID();
  const timestamp = '2026-01-01T00:00:00.000Z';
  const document = {
    format: 'sesame-memos',
    schema_version: 2,
    export_id: randomUUID(),
    exported_at: timestamp,
    books: [
      {
        source_book_id: sourceBook,
        name: '来源本子',
        type: 'normal',
        created_at: timestamp,
        updated_at: timestamp,
        entries: [
          {
            source_entry_id: sourceEntry,
            source_book_id: sourceBook,
            book_type: 'normal',
            title: '中文导入与文档验收',
            body_format: 'delta_v1',
            body: {
              ops: [
                { insert: '这是真实导入的中文正文', attributes: { bold: true } },
                { insert: '\n安全文本 <script>不执行</script>\n' },
              ],
            },
            order_key: null,
            created_at: timestamp,
            updated_at: timestamp,
          },
        ],
      },
    ],
  } satisfies MemoImportDocument;
  const file = {
    name: 'memo-import.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(document)),
  };
  for (let attempt = 0; attempt < 2; attempt++) {
    await openBookManagement(page, 'memos');
    await page.getByRole('button', { name: '导入', exact: true }).click();
    await page.getByLabel('选择文件', { exact: true }).setInputFiles(file);
    await page.getByRole('button', { name: '确认导入', exact: true }).click();
    await expect(page.getByRole('status').filter({ hasText: '导入完成' })).toContainText(
      attempt === 0 ? '已导入 1 条' : '已存在跳过 1 条',
    );
    await page.getByRole('button', { name: '完成', exact: true }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
  }
  const entries = unwrap(
    await peer.client.GET('/api/v1/memo-books/{memo_book_id}/entries', {
      params: { path: { memo_book_id: book.id } },
    }),
  ).items;
  expect(entries).toHaveLength(1);
  expect(entries[0]?.id).not.toBe(sourceEntry);
  expect(entries[0]?.memo_book_id).toBe(book.id);
  expect(entries[0]?.title).toBe('中文导入与文档验收');
  await expect(page.getByRole('button', { name: '打开 中文导入与文档验收', exact: true })).toBeVisible();

  await openBookManagement(page, 'memos');
  await page.getByRole('button', { name: '导出', exact: true }).click();
  const jsonDownload = page.waitForEvent('download');
  await page.getByRole('button', { name: '下载 JSON', exact: true }).click();
  const json = JSON.parse((await downloaded(await jsonDownload, testInfo)).toString()) as MemoImportDocument;
  expect(json.format).toBe('sesame-memos');
  expect(json.books[0]?.entries[0]?.title).toBe('中文导入与文档验收');
  expect(JSON.stringify(json)).not.toContain(account.password);
  await page.getByRole('dialog').getByRole('button', { name: '关闭弹窗', exact: true }).click();
  await page.getByRole('button', { name: '导出 中文导入与文档验收', exact: true }).click();

  const markdownDownload = page.waitForEvent('download');
  await page.getByRole('button', { name: '下载 Markdown', exact: true }).click();
  expect((await downloaded(await markdownDownload, testInfo)).toString()).toContain('**这是真实导入的中文正文**');
  const wordDownload = page.waitForEvent('download');
  await page.getByRole('button', { name: '下载 Word (.docx)', exact: true }).click();
  const word = wordDocument(await downloaded(await wordDownload, testInfo));
  expect(word).toContain('这是真实导入的中文正文');
  expect(word).toContain('Microsoft YaHei');
  expect(word).toContain('&lt;script&gt;');
  const pngDownload = page.waitForEvent('download');
  await page.getByRole('button', { name: '下载图片 (.png)', exact: true }).click();
  const png = await downloaded(await pngDownload, testInfo);
  expect(png.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  expect(png.readUInt32BE(16)).toBe(1720);
  expect(png.readUInt32BE(20)).toBeGreaterThan(100);

  const popupPromise = page.waitForEvent('popup');
  await page.getByRole('button', { name: '打印 / 保存为 PDF', exact: true }).click();
  const popup = await popupPromise;
  await expect(popup.getByRole('heading', { name: '中文导入与文档验收', exact: true })).toBeVisible();
  await expect(popup.getByRole('button', { name: '打印 / 保存为 PDF', exact: true })).toBeVisible();
  expect(await popup.evaluate(() => window.opener)).toBeNull();
  expect(await popup.locator('script').count()).toBe(0);
  // Chromium 打印渲染生成 PDF；Windows 系统打印对话框仍需用户手动验收。
  const pdf = await popup.pdf({ format: 'A4', printBackground: true });
  expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
  await testInfo.attach('memo-print.pdf', { body: pdf, contentType: 'application/pdf' });
  await popup.close();
});

test('日子五种文件格式、非标准列映射、导入预览与重复导入跳过', async ({ page, account }, testInfo) => {
  const peer = await peerClient(account);
  await login(page, account);
  await page.goto('/days');
  await ensureRecordingStarted(page, 'days');
  await openBookManagement(page, 'days');
  await page.getByRole('button', { name: '新建日子本', exact: true }).click();
  await page.getByRole('dialog').getByLabel('名称', { exact: true }).fill('CSV 交换验收');
  await page.getByRole('button', { name: '保存本子', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  const book = unwrap(await peer.client.GET('/api/v1/sync/day-books')).day_books.find(
    (item) => item.name === 'CSV 交换验收',
  )!;
  const file = {
    name: 'days.csv',
    mimeType: 'text/csv',
    buffer: Buffer.from('事件名,日期列\n中文映射日子,2024-02-29\n'),
  };
  for (let attempt = 0; attempt < 2; attempt++) {
    await page.getByRole('button', { name: '导入', exact: true }).click();
    await page.getByLabel('选择日子文件', { exact: true }).setInputFiles(file);
    const dialog = page.getByRole('dialog', { name: '导入日子数据', exact: true });
    await dialog.getByLabel('名称', { exact: true }).selectOption('事件名');
    await dialog.getByLabel('日期', { exact: true }).selectOption('日期列');
    await dialog.getByRole('button', { name: '校验并预览', exact: true }).click();
    await expect(dialog.getByText('中文映射日子 · 纪念日', { exact: true })).toBeVisible();

    await dialog.getByRole('button', { name: '确认导入', exact: true }).click();
    await expect(dialog.getByRole('status').filter({ hasText: '导入完成' })).toContainText(
      attempt === 0 ? '已导入 1 条' : '已存在跳过 1 条',
    );
    await dialog.getByRole('button', { name: '完成', exact: true }).click();
  }
  const events = unwrap(
    await peer.client.GET('/api/v1/day-books/{day_book_id}/events', {
      params: { path: { day_book_id: book.id } },
    }),
  ).items;
  expect(events).toHaveLength(1);
  expect(events[0]).toMatchObject({
    name: '中文映射日子',
    event: { solar_date: '2024-02-29', calendar_type: 'solar' },
  });
  await expect(page.getByRole('button', { name: '编辑 中文映射日子', exact: true })).toBeVisible();
  const workbook = new ExcelJS.Workbook();
  workbook.addWorksheet('日子').addRows([
    ['name', 'date'],
    ['XLSX 日子', '2026-01-02'],
  ]);
  const extraFiles = [
    {
      name: 'days.tsv',
      mimeType: 'text/tab-separated-values',
      buffer: Buffer.from('name\tdate\nTSV 日子\t2026-01-02\n'),
    },
    { name: 'days.txt', mimeType: 'text/plain', buffer: Buffer.from('name,date\n+SUM(1+1),2026-01-02\n') },
    {
      name: 'days.json',
      mimeType: 'application/json',
      buffer: Buffer.from(JSON.stringify({ records: [{ name: 'JSON 日子', date: '2026-01-02' }] })),
    },
    {
      name: 'days.xlsx',
      mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      buffer: Buffer.from(await workbook.xlsx.writeBuffer()),
    },
  ];
  for (const additional of extraFiles) {
    await page.getByRole('button', { name: '导入', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: '导入日子数据', exact: true });
    await dialog.getByLabel('选择日子文件', { exact: true }).setInputFiles(additional);
    await dialog.getByRole('button', { name: '校验并预览', exact: true }).click();
    await dialog.getByRole('button', { name: '确认导入', exact: true }).click();
    await expect(dialog.getByRole('status').filter({ hasText: '导入完成' })).toContainText('已导入 1 条');
    await dialog.getByRole('button', { name: '完成', exact: true }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
  }
  const allEvents = unwrap(
    await peer.client.GET('/api/v1/day-books/{day_book_id}/events', {
      params: { path: { day_book_id: book.id } },
    }),
  ).items;
  expect(allEvents).toHaveLength(5);
  expect(allEvents.map((event) => event.name)).toEqual(
    expect.arrayContaining(['中文映射日子', 'TSV 日子', '+SUM(1+1)', 'JSON 日子', 'XLSX 日子']),
  );

  await page.getByRole('button', { name: '导出', exact: true }).click();
  const dayExport = page.getByRole('dialog', { name: '导出日子本', exact: true });
  await expect(dayExport.getByLabel('CSV 用途', { exact: true })).toHaveValue('safe');
  const dayDownload = page.waitForEvent('download');
  await dayExport.getByRole('button', { name: '下载 CSV', exact: true }).click();
  const safeCsv = (await downloaded(await dayDownload, testInfo)).toString();
  expect(safeCsv).toContain("'+SUM(1+1)");
  for (const event of allEvents) expect(safeCsv).toContain(event.name);
  expect(allEvents.find((event) => event.name === '+SUM(1+1)')?.name).toBe('+SUM(1+1)');
  await dayExport.getByRole('button', { name: '关闭弹窗', exact: true }).click();
  await testInfo.attach('csv-import-result', {
    body: await page.screenshot({ fullPage: true }),
    contentType: 'image/png',
  });
});

test('账号密码卡片多选导出只包含选中内容，选择界面展示对应字段', async ({ page, account }, testInfo) => {
  await login(page, account);
  await page.goto('/credentials');
  await ensureRecordingStarted(page, 'credentials');
  await openBookManagement(page, 'credentials');
  await page.getByRole('button', { name: '新建本子', exact: true }).click();
  await page.getByRole('dialog').getByLabel('名称', { exact: true }).fill('合并卡片导出验收');
  await page.getByRole('button', { name: '保存本子', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  const cards = [
    { title: '保留的测试账号', username: 'included-test-user', secret: 'included-test-secret' },
    { title: '排除的测试账号', username: 'excluded-test-user', secret: 'excluded-test-secret' },
  ];
  for (const card of cards) {
    await page.getByRole('button', { name: '新建账号卡片', exact: true }).click();
    await page.getByLabel('标题', { exact: true }).fill(card.title);
    await page.getByLabel('字段 1 值', { exact: true }).fill(card.username);
    await page.getByLabel('字段 2 值', { exact: true }).fill(card.secret);
    await page.getByRole('button', { name: '保存账号卡片', exact: true }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
  }
  await openBookManagement(page, 'credentials');
  await page.getByRole('button', { name: '合并导出卡片', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '合并导出账号密码卡片', exact: true });
  await expect(dialog.getByRole('checkbox', { name: cards[0]!.title, exact: true })).toBeChecked();
  await expect(dialog.getByRole('checkbox', { name: cards[1]!.title, exact: true })).toBeChecked();
  for (const card of cards) {
    await expect(dialog).toContainText(card.username);
    await expect(dialog).toContainText(card.secret);
  }
  const wordButton = dialog.getByRole('button', { name: '下载合并 Word (.docx)', exact: true });
  await expect(wordButton).toBeEnabled();
  await dialog.getByRole('checkbox', { name: cards[1]!.title, exact: true }).uncheck();

  const wordDownload = page.waitForEvent('download');
  await wordButton.click();
  const word = wordDocument(await downloaded(await wordDownload, testInfo));
  expect(word).toContain(cards[0]!.title);
  expect(word).toContain(cards[0]!.username);
  expect(word).toContain(cards[0]!.secret);
  expect(word).not.toContain(cards[1]!.title);
  expect(word).not.toContain(cards[1]!.username);
  expect(word).not.toContain(cards[1]!.secret);
  expect(word).not.toContain(account.password);
  await dialog.getByRole('checkbox', { name: cards[1]!.title, exact: true }).check();
  await expect(wordButton).toBeEnabled();
  await dialog.getByRole('button', { name: '取消全选', exact: true }).click();
  await expect(wordButton).toBeDisabled();
});

test('通用备忘录 XLSX 正文与账号 CSV 字段映射经过预览再导入', async ({ page, account }) => {
  const peer = await peerClient(account);
  await login(page, account);
  await page.goto('/memos');
  const workbook = new ExcelJS.Workbook();
  workbook.addWorksheet('笔记').addRows([
    ['title', 'body'],
    ['工作表备忘录', '保留换行\n中文第二行'],
  ]);
  for (const type of ['normal', 'credentials'] as const) {
    const kind = type === 'credentials' ? 'credentials' : 'memos';
    await page.goto(type === 'credentials' ? '/credentials' : '/memos');
    await ensureRecordingStarted(page, kind);
    await openBookManagement(page, kind);
    await page.getByRole('button', { name: '新建本子', exact: true }).click();
    await page
      .getByRole('dialog')
      .getByLabel('名称', { exact: true })
      .fill(type === 'normal' ? '普通表格验收' : '私密表格验收');
    await page.getByRole('button', { name: '保存本子', exact: true }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await openBookManagement(page, kind);
    await page.getByRole('button', { name: '导入', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: '导入备忘录数据', exact: true });
    await dialog.getByLabel('选择文件', { exact: true }).setInputFiles(
      type === 'normal'
        ? {
            name: 'memos.xlsx',
            mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
            buffer: Buffer.from(await workbook.xlsx.writeBuffer()),
          }
        : {
            name: 'cards.csv',
            mimeType: 'text/csv',
            buffer: Buffer.from(
              'title,username,password,ignored\n映射测试卡片,mapped-user,mapped-private,excluded-column\n',
            ),
          },
    );
    if (type === 'credentials') {
      await dialog.getByLabel('password → 字段名', { exact: true }).fill('登录密码');
      await dialog.getByLabel('ignored → 字段名', { exact: true }).fill('');
    }
    await dialog.getByRole('button', { name: '校验并预览', exact: true }).click();
    const submit = dialog.getByRole('button', { name: '确认导入', exact: true });
    if (type === 'credentials') {
      await expect(dialog).toContainText('mapped-private');
      await expect(dialog).toContainText('mapped-user');
      await expect(submit).toBeEnabled();
    }

    await submit.click();
    await expect(dialog.getByRole('status').filter({ hasText: '导入完成' })).toContainText('已导入 1 条');
    await dialog.getByRole('button', { name: '完成', exact: true }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    const book = unwrap(await peer.client.GET('/api/v1/sync/memo-books')).memo_books.find(
      (item) => item.type === type && item.name === (type === 'normal' ? '普通表格验收' : '私密表格验收'),
    )!;
    const entries = unwrap(
      await peer.client.GET('/api/v1/memo-books/{memo_book_id}/entries', {
        params: { path: { memo_book_id: book.id } },
      }),
    ).items;
    expect(entries).toHaveLength(1);
    if (type === 'normal') {
      expect(entries[0]?.title).toBe('工作表备忘录');
      expect(entries[0]?.body).toEqual({ ops: [{ insert: '保留换行\n中文第二行\n' }] });
    } else {
      expect(entries[0]?.title).toBe('映射测试卡片');
      const body = JSON.stringify(entries[0]?.body);
      expect(body).toContain('mapped-user');
      expect(body).toContain('登录密码');
      expect(body).toContain('mapped-private');
      expect(body).not.toContain('excluded-column');
      await expect(page.getByRole('button', { name: '打开 映射测试卡片', exact: true })).toContainText(
        'mapped-private',
      );
    }
  }
});
