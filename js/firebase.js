import { initializeApp } from "https://www.gstatic.com/firebasejs/10.8.1/firebase-app.js";
import { getFirestore } from "https://www.gstatic.com/firebasejs/10.8.1/firebase-firestore.js";
import { getAuth, signInAnonymously } from "https://www.gstatic.com/firebasejs/10.8.1/firebase-auth.js";
import { firebaseConfig } from "./config.js";

// Firebase 클라이언트 설정값은 js/config.js 에 있습니다.
// - js/config.js 는 gitignore 처리되어 저장소에 커밋되지 않습니다(공개 소스에서 값 제거).
// - 로컬: .env 채우고 `npm run build`  /  Vercel: 대시보드 환경 변수 → 빌드 시 자동 생성 (SECURITY.md 참고)
// ※ 다만 이 값들은 배포된 사이트의 브라우저에서는 여전히 노출됩니다(클라이언트 SDK 특성). 비밀이 아니며,
//    실제 접근 제어는 Firestore Security Rules(firestore.rules)가 담당합니다.
export const app = initializeApp(firebaseConfig);
export const db = getFirestore(app);
export const auth = getAuth(app);

// 익명 인증 시도.
// - 콘솔에서 Anonymous 로그인이 활성화되어 있으면: 브라우저별 고유 uid 반환
//   → Security Rules가 이 uid로 소유권(방장/업로더)을 서버 측에서 강제할 수 있음
// - 아직 비활성 상태면: null 반환 → 앱은 localStorage 기반 ID로 폴백 (규칙 적용 전까지의 과도기)
export async function ensureAnonymousUser() {
    try {
        const cred = await signInAnonymously(auth);
        return cred.user.uid;
    } catch (e) {
        console.warn('익명 인증을 사용할 수 없어 localStorage ID로 폴백합니다:', e.code);
        return null;
    }
}
