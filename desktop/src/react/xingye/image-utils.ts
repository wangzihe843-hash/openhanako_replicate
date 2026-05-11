export const MAX_CHAT_BACKGROUND_BYTES = 3 * 1024 * 1024;
export const MAX_CHAT_BACKGROUND_WIDTH = 1600;

const CHAT_BACKGROUND_QUALITY = 0.88;
const ACCEPTED_CHAT_BACKGROUND_TYPES = new Set([
  'image/png',
  'image/jpeg',
  'image/jpg',
  'image/webp',
]);
const ACCEPTED_CHAT_BACKGROUND_EXTENSIONS = new Set([
  'png',
  'jpg',
  'jpeg',
  'webp',
]);

export type ProcessedChatBackgroundImage = {
  dataUrl: string;
  width: number;
  height: number;
};

export function validateChatBackgroundFile(file: File): void {
  if (file.size > MAX_CHAT_BACKGROUND_BYTES) {
    throw new Error('图片不能超过 3MB');
  }

  const fileType = file.type.trim().toLowerCase();
  const extension = getFileExtension(file.name);
  const acceptedByMime = fileType ? ACCEPTED_CHAT_BACKGROUND_TYPES.has(fileType) : false;
  const acceptedByExtension = !fileType && ACCEPTED_CHAT_BACKGROUND_EXTENSIONS.has(extension);

  if (!acceptedByMime && !acceptedByExtension) {
    throw new Error('请选择 png / jpg / webp 图片');
  }
}

export async function processChatBackgroundFile(file: File): Promise<ProcessedChatBackgroundImage> {
  validateChatBackgroundFile(file);

  const originalDataUrl = await readFileAsDataUrl(file);
  const image = await decodeImage(originalDataUrl);
  if (image.naturalWidth <= MAX_CHAT_BACKGROUND_WIDTH) {
    return {
      dataUrl: originalDataUrl,
      width: image.naturalWidth,
      height: image.naturalHeight,
    };
  }

  const scale = image.naturalWidth > MAX_CHAT_BACKGROUND_WIDTH
    ? MAX_CHAT_BACKGROUND_WIDTH / image.naturalWidth
    : 1;
  const width = Math.max(1, Math.round(image.naturalWidth * scale));
  const height = Math.max(1, Math.round(image.naturalHeight * scale));
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;

  const context = canvas.getContext('2d');
  if (!context) {
    throw new Error('图片压缩失败');
  }

  try {
    context.drawImage(image, 0, 0, width, height);
    const dataUrl = canvas.toDataURL('image/webp', CHAT_BACKGROUND_QUALITY);
    if (!dataUrl || !dataUrl.startsWith('data:image/')) {
      throw new Error('Invalid canvas data URL');
    }

    return { dataUrl, width, height };
  } catch {
    throw new Error('图片压缩失败');
  }
}

function getFileExtension(fileName: string): string {
  const match = /\.([^.]+)$/.exec(fileName.trim().toLowerCase());
  return match?.[1] ?? '';
}

function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();

    reader.onload = () => {
      if (typeof reader.result === 'string' && reader.result.startsWith('data:')) {
        resolve(reader.result);
        return;
      }

      reject(new Error('图片读取失败'));
    };
    reader.onerror = () => reject(new Error('图片读取失败'));

    try {
      reader.readAsDataURL(file);
    } catch {
      reject(new Error('图片读取失败'));
    }
  });
}

function decodeImage(dataUrl: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();

    image.onload = () => {
      if (!image.naturalWidth || !image.naturalHeight) {
        reject(new Error('图片解码失败'));
        return;
      }

      resolve(image);
    };
    image.onerror = () => reject(new Error('图片解码失败'));

    image.src = dataUrl;
  });
}
