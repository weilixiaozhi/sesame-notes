import { unwrap } from '@sesame-notes/api-client';
import { api } from '../../lib/session';
import { logMemoError } from './memo-content';

/** 图片压缩后的最长边与体积上限，与服务端可接收的单张图片约束一致。 */
const maxImageEdge = 2048;
const maxImageBytes = 8 * 1024 * 1024;
const jpegQuality = 0.85;

/** 图片引用由客户端生成，加载失败时返回空值并由调用方降级为占位。 */
export type MemoImageLoader = (mediaId: string, signal?: AbortSignal) => Promise<Blob | null>;

/** 通过 FileReader 读取图片字节，避免依赖 Blob 的大型二进制接口。 */
export function readBlobBytes(blob: Blob): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error('读取图片失败'));
    reader.onload = () => resolve(new Uint8Array(reader.result as ArrayBuffer));
    reader.readAsArrayBuffer(blob);
  });
}

/**
 * 分块把字节转换成 base64。
 * 大图直接展开到函数参数会超出调用栈上限，因此按固定块大小逐段编码后拼接。
 */
function bytesToBase64(bytes: Uint8Array): string {
  const chunks: string[] = [];
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    chunks.push(String.fromCharCode(...bytes.subarray(offset, offset + chunkSize)));
  }
  return btoa(chunks.join(''));
}

/** canvas 异步编码为指定格式，编码失败时抛出错误交给上传流程提示用户。 */
function canvasToBlob(canvas: HTMLCanvasElement, type: string, quality?: number): Promise<Blob> {
  return new Promise((resolve, reject) => {
    try {
      canvas.toBlob(
        (blob) => {
          if (blob) resolve(blob);
          else reject(new Error('图片编码失败'));
        },
        type,
        quality,
      );
    } catch (error) {
      reject(error);
    }
  });
}

/** 检查画布中是否存在半透明像素，用于决定是否保留 PNG 的透明背景。 */
function hasTransparentPixel(context: CanvasRenderingContext2D, width: number, height: number): boolean {
  const { data } = context.getImageData(0, 0, width, height);
  for (let index = 3; index < data.length; index += 4) {
    if (data[index]! < 255) return true;
  }
  return false;
}

/**
 * 在本地把图片压缩到最长边 2048 像素。
 * 透明图片输出 PNG，其余输出 JPEG；压缩结果仍超过 8 MB 时拒绝上传。
 */
async function compressMemoImage(file: File): Promise<{ blob: Blob; contentType: 'image/png' | 'image/jpeg' }> {
  if (file.size > maxImageBytes) throw new Error('图片超过 8 MB，请更换图片');
  const bitmap = await createImageBitmap(file);
  try {
    const scale = Math.min(1, maxImageEdge / Math.max(bitmap.width, bitmap.height));
    const width = Math.max(1, Math.round(bitmap.width * scale));
    const height = Math.max(1, Math.round(bitmap.height * scale));
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('当前浏览器无法处理图片');
    context.drawImage(bitmap, 0, 0, width, height);
    // JPEG 不承载透明通道，只有 PNG/WebP 来源才需要检查透明像素。
    const keepsAlpha = file.type !== 'image/jpeg' && hasTransparentPixel(context, width, height);
    const contentType = keepsAlpha ? 'image/png' : 'image/jpeg';
    const blob = await canvasToBlob(canvas, contentType, keepsAlpha ? undefined : jpegQuality);
    if (blob.size > maxImageBytes) throw new Error('图片压缩后仍超过 8 MB，请更换图片');
    return { blob, contentType };
  } finally {
    bitmap.close();
  }
}

/** 压缩图片后生成媒体标识并上传，返回写入正文的图片引用。 */
export async function uploadMemoImage(file: File): Promise<string> {
  const { blob, contentType } = await compressMemoImage(file);
  const bytes = await readBlobBytes(blob);
  const mediaId = crypto.randomUUID();
  const result = await api.PUT('/api/v1/memo-media/{media_id}', {
    params: { path: { media_id: mediaId } },
    body: { content_type: contentType, data_base64: bytesToBase64(bytes) },
  });
  unwrap(result);
  return mediaId;
}

/** 仅本人可读的图片字节；网络失败或图片已不存在时返回空值并记录诊断信息。 */
export const loadMemoImage: MemoImageLoader = async (mediaId, signal) => {
  try {
    const result = await api.GET('/api/v1/memo-media/{media_id}', {
      params: { path: { media_id: mediaId } },
      parseAs: 'blob',
      signal,
    });
    return unwrap(result) ?? null;
  } catch (error) {
    // 组件卸载或切换导出任务会中止请求，不属于需要提示的加载失败。
    if (signal?.aborted) return null;
    logMemoError('加载备忘录图片失败', error, { mediaId });
    return null;
  }
};
