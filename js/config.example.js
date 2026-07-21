// 템플릿 파일 — 실제 값이 담긴 js/config.js 는 gitignore 되어 저장소에 없습니다.
//
// 로컬에서 실행하려면 둘 중 하나:
//   1) 저장소 루트에 .env 를 만들고(.env.example 참고) `npm run build` 실행 → js/config.js 자동 생성
//   2) 이 파일을 js/config.js 로 복사한 뒤 값을 직접 채우기
//
// ※ 이 값들은 브라우저에 노출됩니다(Firebase 클라이언트 SDK 특성). 비밀이 아니며,
//    실제 접근 제어는 firestore.rules 가 담당합니다. 자세한 내용은 SECURITY.md 참고.
export const firebaseConfig = {
    apiKey: "YOUR_FIREBASE_API_KEY",
    authDomain: "YOUR_PROJECT.firebaseapp.com",
    projectId: "YOUR_PROJECT_ID",
    storageBucket: "YOUR_PROJECT.firebasestorage.app",
    messagingSenderId: "YOUR_SENDER_ID",
    appId: "YOUR_APP_ID",
    measurementId: "YOUR_MEASUREMENT_ID"
};
