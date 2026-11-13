import { ApiError } from './errors.js';

/** 服务端接受的图片 MIME 与固定扩展名，文件名不接受客户端输入。 */
export const IMAGE_CONTENT_TYPES = ['image/png', 'image/jpeg', 'image/webp'] as const;

export type ImageContentType = (typeof IMAGE_CONTENT_TYPES)[number];

/** 重编码后的图片字节与真实像素尺寸。 */
export type SanitizedImage = {
  bytes: Buffer;
  width: number;
  height: number;
  format: 'png' | 'jpeg' | 'webp';
};

type SharpFactory = (typeof import('sharp'))['default'];

export type SanitizeImageOptions = {
  contentType: ImageContentType;
  /** 客户端提交的 Base64 正文，解码前不信任任何声明。 */
  data: string;
  /** 原始字节上限（解码前）。 */
  maxBytes: number;
  /** 单边像素上限，与总像素上限共同构成解压炸弹防护。 */
  maxDimension: number;
  /** 总像素上限。 */
  maxPixels: number;
  /** 输出最长边上限；未提供时保留原始尺寸，只做元数据剥离。 */
  maxOutputDimension?: number;
  /** JPEG/WebP 重编码质量，PNG 始终无损。 */
  quality?: number;
  tooLargeCode: string;
  tooLargeMessage: string;
  invalidCode: string;
  invalidMessage: string;
};

/** 根据受支持的 MIME 类型选择固定扩展名。 */
export function imageExtension(contentType: ImageContentType): '.png' | '.jpg' | '.webp' {
  return contentType === 'image/png' ? '.png' : contentType === 'image/jpeg' ? '.jpg' : '.webp';
}

/** 从服务端生成的扩展名恢复 MIME 类型。 */
export function imageContentType(fileName: string): ImageContentType {
  if (fileName.endsWith('.png')) return 'image/png';
  if (fileName.endsWith('.jpg')) return 'image/jpeg';
  if (fileName.endsWith('.webp')) return 'image/webp';
  throw new ApiError(404, 'IMAGE_NOT_FOUND', '图片文件无效');
}

/** 文件头签名与声明类型必须一致，避免把其他格式送进原生解码器。 */
function signatureMatches(contentType: ImageContentType, bytes: Buffer): boolean {
  if (contentType === 'image/png') return bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'));
  if (contentType === 'image/jpeg') return bytes.subarray(0, 3).equals(Buffer.from('ffd8ff', 'hex'));
  return bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP';
}

/**
 * 解码并净化图片：完整解码验证（不只校验文件头）、像素上限检查，
 * 再统一重编码以剥离 EXIF/定位等元数据；日志不记录 Base64 内容。
 *
 * 设计意图：仅靠文件头签名无法识别伪装图片，重编码同时满足
 * 「真实可解码」「像素受限」「元数据零残留」三个信任边界。
 */
export async function sanitizeImage(options: SanitizeImageOptions): Promise<SanitizedImage> {
  const { contentType, data, maxBytes, maxDimension, maxPixels, maxOutputDimension, quality = 92 } = options;
  const invalid = (): never => {
    throw new ApiError(422, options.invalidCode, options.invalidMessage);
  };
  const tooLarge = (): never => {
    throw new ApiError(413, options.tooLargeCode, options.tooLargeMessage);
  };
  try {
    const bytes = Buffer.from(data, 'base64');
    if (!bytes.length) throw invalid();
    if (bytes.length > maxBytes) throw tooLarge();
    // Base64 必须能无损还原原始字节，避免声明长度与实际内容不一致。
    if (bytes.toString('base64').replace(/=+$/, '') !== data.replace(/=+$/, '')) throw invalid();
    if (!signatureMatches(contentType, bytes)) throw invalid();
    // 按需加载原生库，文件签名通过后仍须完整解码、核对格式并重新编码。
    const sharp = (await import('sharp')).default as SharpFactory;
    const input = sharp(bytes, { failOn: 'error', limitInputPixels: maxPixels });
    const metadata = await input.metadata();
    const actualFormat = metadata.format;
    if (!actualFormat || !['png', 'jpeg', 'webp'].includes(actualFormat)) throw invalid();
    const declared = contentType === 'image/png' ? 'png' : contentType === 'image/jpeg' ? 'jpeg' : 'webp';
    if (actualFormat !== declared) throw invalid();
    const width = metadata.width ?? 0;
    const height = metadata.height ?? 0;
    if (width > maxDimension || height > maxDimension || width * height > maxPixels) throw tooLarge();
    // 重编码：应用 EXIF 方向到像素后丢弃全部元数据；解码失败同样视为无效图片。
    let pipeline = sharp(bytes, { failOn: 'error', limitInputPixels: maxPixels }).rotate();
    if (maxOutputDimension !== undefined) {
      pipeline = pipeline.resize({
        width: maxOutputDimension,
        height: maxOutputDimension,
        fit: 'inside',
        withoutEnlargement: true,
      });
    }
    const output =
      actualFormat === 'png'
        ? await pipeline.png().toBuffer()
        : actualFormat === 'jpeg'
          ? await pipeline.jpeg({ quality }).toBuffer()
          : await pipeline.webp({ quality }).toBuffer();
    if (!output.length) throw invalid();
    // 输出尺寸由重编码结果决定：方向应用与缩放都可能改变宽高。
    const outputMetadata = await sharp(output).metadata();
    const outputWidth = outputMetadata.width ?? 0;
    const outputHeight = outputMetadata.height ?? 0;
    if (!outputWidth || !outputHeight) throw invalid();
    return {
      bytes: output,
      width: outputWidth,
      height: outputHeight,
      format: actualFormat as SanitizedImage['format'],
    };
  } catch (error) {
    if (error instanceof ApiError) throw error;
    // sharp 的像素上限保护直接以异常形式暴露：与业务像素超限统一为 413。
    if (error instanceof Error && /exceeds pixel limit/i.test(error.message)) throw tooLarge();
    throw invalid();
  }
}
