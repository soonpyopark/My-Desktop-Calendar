/**
 * @param {ArrayBuffer} buffer
 * @param {string} fileName
 * @param {string} contentType
 */
export function downloadBuffer(buffer, fileName, contentType) {
  if (!buffer || buffer.byteLength === 0) {
    throw new Error('다운로드 파일이 비어 있습니다.');
  }

  const blob = new Blob([buffer], { type: contentType });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = fileName;
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

/**
 * @param {ArrayBuffer} buffer
 * @param {'excel' | 'pdf'} format
 */
function assertValidExportBuffer(buffer, format) {
  const bytes = new Uint8Array(buffer);
  if (bytes.length < 4) {
    throw new Error('내보내기 파일이 비어 있습니다. 앱을 완전히 종료한 뒤 다시 실행해 주세요.');
  }

  const isPdf = bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46;
  const isZip = bytes[0] === 0x50 && bytes[1] === 0x4b;

  if (format === 'pdf' && !isPdf) {
    throw new Error('PDF 파일을 만들 수 없습니다. 앱을 완전히 종료한 뒤 다시 실행해 주세요.');
  }

  if (format === 'excel' && !isZip) {
    throw new Error('Excel 파일을 만들 수 없습니다. 앱을 완전히 종료한 뒤 다시 실행해 주세요.');
  }
}

/**
 * @param {Response} response
 * @param {string} fallbackName
 * @param {'excel' | 'pdf'} format
 */
export async function downloadExportResponse(response, fallbackName, format) {
  const contentType = response.headers.get('Content-Type') ?? '';

  if (!response.ok) {
    const errorBody = await response.text();
    let message = '내보내기에 실패했습니다.';
    try {
      const parsed = JSON.parse(errorBody);
      if (parsed.error) message = parsed.error;
    } catch {
      if (errorBody) message = errorBody;
    }
    throw new Error(message);
  }

  if (contentType.includes('text/html') || contentType.includes('application/json')) {
    throw new Error(
      '내보내기 API를 사용할 수 없습니다. 앱을 완전히 종료한 뒤 npm run dev로 다시 실행해 주세요.',
    );
  }

  const buffer = await response.arrayBuffer();
  assertValidExportBuffer(buffer, format);

  const disposition = response.headers.get('Content-Disposition') ?? '';
  const matchedName = /filename\*=UTF-8''([^;]+)|filename="([^"]+)"/i.exec(disposition);
  const fileName = decodeURIComponent(matchedName?.[1] ?? matchedName?.[2] ?? fallbackName);

  downloadBuffer(buffer, fileName, contentType);
}
