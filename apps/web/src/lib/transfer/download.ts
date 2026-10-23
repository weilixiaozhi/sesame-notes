/** 只在用户点击后创建临时下载地址，下载触发后释放内存。 */
export function downloadText(text: string, fileName: string, type: string): void {
  const blob = new Blob([text], { type });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  try {
    link.href = url;
    link.download = fileName;
    link.rel = 'noopener';
    document.body.append(link);
    link.click();
    link.remove();
  } finally {
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
}

/** 下载文件名去掉文件系统禁用字符，名称不影响文档里的原始标题。 */
export function exportFileName(name: string): string {
  return name.replace(/[<>:"/\\|?*\p{Cc}]/gu, '_').slice(0, 80) || 'sesame-notes';
}
