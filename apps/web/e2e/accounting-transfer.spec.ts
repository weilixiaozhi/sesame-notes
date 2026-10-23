import { readFile } from 'node:fs/promises';
import ExcelJS from 'exceljs';
import { unwrap } from '@sesame-notes/api-client';
import { test, expect, login, peerClient } from './fixtures';
import { ensureRecordingStarted } from './recording-start';

test('记账五种文件格式、手动映射、重复跳过、无效行不写入与完整 CSV 导出', async ({ page, account }, testInfo) => {
  test.setTimeout(120_000);
  const peer = await peerClient(account);
  await login(page, account);
  await page.goto('/accounting');
  await ensureRecordingStarted(page, 'accounting');
  await page.getByRole('button', { name: '账本管理', exact: true }).click();
  await page.getByRole('button', { name: '新建账本', exact: true }).click();
  await page.getByLabel('账本名称').fill('文件交换验收账本');
  await page.getByRole('button', { name: '保存账本', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  const ledger = unwrap(await peer.client.GET('/api/v1/ledgers')).find((item) => item.name === '文件交换验收账本')!;
  const initialCategories = unwrap(
    await peer.client.GET('/api/v1/ledgers/{ledger_id}/categories', { params: { path: { ledger_id: ledger.id } } }),
  );
  expect(initialCategories).toHaveLength(61);
  const dining = initialCategories.find((item) => item.id === 'ffec6471-df8b-5bb3-8a05-93ef863ca958')!;
  const lunch = initialCategories.find((item) => item.name === '午餐' && item.parent_id === dining.id)!;
  expect(lunch).toBeDefined();
  const transactions = async () =>
    unwrap(
      await peer.client.GET('/api/v1/ledgers/{ledger_id}/transactions', {
        params: { path: { ledger_id: ledger.id } },
      }),
    ).items;
  const timestamp = new Date().toISOString();
  const headers = ['类型', '分类', '二级分类', '金额', '币种', '备注', '时间'];
  const row = (amount: string, note: string) => ['支出', '餐饮', '午餐', amount, 'CNY', note, timestamp];
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('明细');
  sheet.addRows([headers, row('10.04', '来自 XLSX')]);
  const jsonRow = Object.fromEntries(headers.map((header, index) => [header, row('10.03', '@SUM(1+1)')[index]]));
  const files = [
    {
      name: 'mapped.csv',
      mimeType: 'text/csv',
      buffer: Buffer.from(`交易日,花费,说点什么\n${timestamp},12.34,来自手动 CSV\n`),
    },
    {
      name: 'expense.tsv',
      mimeType: 'text/tab-separated-values',
      buffer: Buffer.from(`${headers.join('\t')}\n${row('10.01', '来自 TSV').join('\t')}\n`),
    },
    {
      name: 'expense.txt',
      mimeType: 'text/plain',
      buffer: Buffer.from(`${headers.join(',')}\n${row('10.02', '来自 TXT').join(',')}\n`),
    },
    { name: 'expense.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify({ records: [jsonRow] })) },
    {
      name: 'expense.xlsx',
      mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      buffer: Buffer.from(await workbook.xlsx.writeBuffer()),
    },
  ];
  /** 每份文件均走页面映射与预览，然后等待真实批次提交完成。 */
  const openImport = async () => {
    await page.getByRole('button', { name: '导入 / 导出', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: '账本数据导入 / 导出', exact: true });
    await dialog.getByRole('button', { name: '导入文件', exact: true }).click();
    return dialog;
  };
  for (const [index, file] of files.entries()) {
    const dialog = await openImport();
    await dialog.getByLabel('选择明细文件', { exact: true }).setInputFiles(file);
    if (index === 0) {
      await dialog.getByLabel('日期 / 时间', { exact: true }).selectOption('交易日');
      await dialog.getByLabel('金额', { exact: true }).selectOption('花费');
      await dialog.getByLabel('备注', { exact: true }).selectOption('说点什么');
    }
    await dialog.getByRole('button', { name: '校验并预览', exact: true }).click();
    await expect(dialog.getByRole('button', { name: '确认导入', exact: true })).toBeEnabled();

    await dialog.getByRole('button', { name: '确认导入', exact: true }).click();
    await expect(dialog.getByRole('status').filter({ hasText: '导入完成' })).toBeVisible();
    await expect(dialog.getByRole('status').filter({ hasText: '正在提交导入批次' })).toHaveCount(0);
    await expect.poll(async () => (await transactions()).length).toBe(index + 1);
    await dialog.getByRole('button', { name: '关闭弹窗', exact: true }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
  }
  const records = await transactions();
  expect(records.map((item) => item.note)).toEqual(
    expect.arrayContaining(['来自手动 CSV', '来自 TSV', '来自 TXT', '@SUM(1+1)', '来自 XLSX']),
  );
  expect(records.find((item) => item.note === '来自手动 CSV')?.amount).toBe('12.34');
  expect(records.find((item) => item.note === '来自 XLSX')).toMatchObject({
    category_name: '午餐',
    category_id: lunch.id,
  });
  const categoriesAfterImport = unwrap(
    await peer.client.GET('/api/v1/ledgers/{ledger_id}/categories', { params: { path: { ledger_id: ledger.id } } }),
  );
  expect(categoriesAfterImport).toEqual(initialCategories);

  const repeat = await openImport();
  await repeat.getByLabel('选择明细文件', { exact: true }).setInputFiles(files[4]!);
  await repeat.getByRole('button', { name: '校验并预览', exact: true }).click();
  await expect(repeat.getByRole('heading', { name: '没有需要导入的新记录', exact: true })).toBeVisible();
  expect(await transactions()).toHaveLength(5);
  await repeat.getByRole('button', { name: '关闭弹窗', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);

  await page.getByRole('button', { name: '导入 / 导出', exact: true }).click();
  const exportDialog = page.getByRole('dialog', { name: '账本数据导入 / 导出', exact: true });
  await exportDialog.getByRole('button', { name: '导出 CSV', exact: true }).click();
  const downloaded = page.waitForEvent('download');
  await exportDialog.getByRole('button', { name: '下载明细 CSV', exact: true }).click();
  const download = await downloaded;
  const path = testInfo.outputPath(download.suggestedFilename());
  await download.saveAs(path);
  await testInfo.attach('accounting-export.csv', { path });
  const csv = await readFile(path, 'utf8');
  for (const record of records) expect(csv).toContain(record.note!);
  expect(csv).toContain('12.34');
  expect(csv).not.toContain(account.password);
  expect(csv).toContain("'@SUM(1+1)");
  await exportDialog.getByLabel('CSV 用途', { exact: true }).selectOption('raw');
  let prematureDownload = 0;
  const countDownload = () => {
    prematureDownload++;
  };
  page.on('download', countDownload);
  await exportDialog.getByRole('button', { name: '下载明细 CSV', exact: true }).click();
  await expect(exportDialog.getByRole('alert')).toBeVisible();
  expect(prematureDownload).toBe(0);
  page.off('download', countDownload);
  await exportDialog.getByRole('checkbox', { name: '我已了解风险，仍下载保留原始内容的 CSV。', exact: true }).check();
  const rawDownload = page.waitForEvent('download');
  await exportDialog.getByRole('button', { name: '下载明细 CSV', exact: true }).click();
  const rawPath = testInfo.outputPath('accounting-raw-values.csv');
  await (await rawDownload).saveAs(rawPath);
  const rawCsv = await readFile(rawPath, 'utf8');
  expect(rawCsv).toContain('@SUM(1+1)');
  expect(rawCsv).not.toContain("'@SUM(1+1)");
  await testInfo.attach('accounting-raw-values.csv', { path: rawPath });
  await exportDialog.getByRole('button', { name: '关闭弹窗', exact: true }).click();

  let invalidWrites = 0;
  await page.route(/\/api\/v1\/ledgers\/[^/]+\/imports(?:\?.*)?$/, async (route) => {
    if (route.request().method() === 'POST') invalidWrites++;
    await route.continue();
  });
  const invalid = await openImport();
  await invalid.getByLabel('选择明细文件', { exact: true }).setInputFiles({
    name: 'invalid.csv',
    mimeType: 'text/csv',
    buffer: Buffer.from(`${headers.join(',')}\n${row('-1', '禁止写入负金额').join(',')}\n`),
  });
  await invalid.getByRole('button', { name: '校验并预览', exact: true }).click();
  await expect(invalid.getByRole('alert')).toContainText('第 2 行');
  await expect(invalid.getByRole('alert')).toBeInViewport();
  await expect(invalid.getByRole('button', { name: '确认导入', exact: true })).toHaveCount(0);
  expect(invalidWrites).toBe(0);
  expect(await transactions()).toHaveLength(5);

  await testInfo.attach('accounting-invalid-import', {
    body: await page.screenshot({ fullPage: (await page.getByRole('dialog').count()) === 0 }),
    contentType: 'image/png',
  });
});
