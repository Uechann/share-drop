// 순수 유틸리티 — DOM/전역 상태에 의존하지 않는 함수만 모음

// XSS 방지용 이스케이프 (업로더 이름/파일명/폴더명 등 외부 입력 값)
export function escapeHtml(str = '') {
    return String(str).replace(/[&<>"']/g, c => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[c]));
}

// 암호 해시 (원문은 저장하지 않음). salt를 섞어 동일 암호라도 방마다 다른 해시가 되게 함
export async function sha256(text) {
    const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
    return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
}

// dataURL → File (Web Share API용)
export function dataUrlToFile(dataUrl, fileName) {
    const [meta, b64] = dataUrl.split(',');
    const mime = (meta.match(/data:(.*?)(;|$)/) || [])[1] || 'image/png';
    const bin = atob(b64);
    const arr = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
    return new File([arr], fileName, { type: mime });
}

// 짧은 방 코드 생성 (8자리 영어숫자)
export function generateRoomCode() {
    return Math.random().toString(36).substring(2, 10).toUpperCase();
}

// 확장자 추출
export function getFormatFromMime(mimeType) {
    if (mimeType.includes('jpeg') || mimeType.includes('jpg')) return 'jpg';
    if (mimeType.includes('png')) return 'png';
    if (mimeType.includes('gif')) return 'gif';
    if (mimeType.includes('mp4')) return 'mp4';
    if (mimeType.includes('webm')) return 'webm';
    if (mimeType.includes('quicktime')) return 'mov';
    return mimeType.startsWith('video/') ? 'video' : 'other';
}

// 포맷 표시 뱃지 색상
export function getFormatBadgeColor(format) {
    switch(format) {
        case 'jpg': return 'bg-blue-100 text-blue-700';
        case 'png': return 'bg-emerald-100 text-emerald-700';
        case 'gif': return 'bg-purple-100 text-purple-700';
        case 'mp4':
        case 'webm':
        case 'mov':
        case 'video': return 'bg-orange-100 text-orange-700';
        default: return 'bg-gray-100 text-gray-700';
    }
}

export function readAsDataURL(file) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = e => resolve(e.target.result);
        reader.onerror = e => reject(e);
        reader.readAsDataURL(file);
    });
}

export function compressImage(file, maxDim, quality = 0.8) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.readAsDataURL(file);
        reader.onload = (e) => {
            const img = new Image();
            img.src = e.target.result;
            img.onload = () => {
                let w = img.width;
                let h = img.height;
                if (w > maxDim || h > maxDim) {
                    if (w > h) { h = Math.round((h * maxDim) / w); w = maxDim; }
                    else { w = Math.round((w * maxDim) / h); h = maxDim; }
                }
                const canvas = document.createElement('canvas');
                canvas.width = w; canvas.height = h;
                const ctx = canvas.getContext('2d');
                ctx.drawImage(img, 0, 0, w, h);
                resolve(canvas.toDataURL(file.type, quality));
            };
            img.onerror = (err) => reject(err);
        };
    });
}
