# ShareDrop 보안 가이드

## 요약: 무엇이 비밀이고 무엇이 아닌가

- **`js/firebase.js`의 apiKey는 비밀키가 아닙니다.** Firebase 클라이언트 apiKey는 "어느 프로젝트인지"를 식별하는 값으로, 웹앱 특성상 사용자 브라우저에 항상 노출됩니다. 공개 레포에 있어도 문제없습니다. ([공식 문서](https://firebase.google.com/docs/projects/api-keys))
- **실제 보안 경계는 Firestore Security Rules입니다.** 규칙이 열려 있으면 apiKey를 숨겨도 아무 소용이 없고, 규칙이 제대로면 apiKey가 공개돼도 안전합니다.

## 지금 반드시 해야 할 콘솔 설정 (순서대로)

### 1. 익명 인증 활성화
[Firebase 콘솔](https://console.firebase.google.com/project/share-drop-621d1) → **Authentication → Sign-in method → 익명(Anonymous) → 사용 설정**

- 코드는 이미 `signInAnonymously`를 사용하도록 되어 있습니다 (`js/firebase.js`).
- 활성화 전에는 localStorage 기반 ID로 자동 폴백되어 앱은 그대로 동작합니다.
- **반드시 2번(규칙 적용)보다 먼저** 해야 합니다. 순서가 바뀌면 인증 없는 사용자의 쓰기가 전부 거부됩니다.

### 2. Firestore 보안 규칙 게시
콘솔 → **Firestore Database → 규칙** 탭 → 이 레포의 [`firestore.rules`](firestore.rules) 내용을 붙여넣고 **게시**

규칙이 서버 측에서 강제하는 것:
| 항목 | 규칙 |
|---|---|
| 방 생성 | 로그인(익명) 필수, 본인 uid를 ownerId로 지정한 경우만 |
| 방 수정/삭제 | 방장(uid 일치)만. 단 `folders` 필드(폴더 생성)는 참여자도 가능 |
| 업로드 | 본인 uid를 uploaderId로 지정 + 방 만료 전 + 업로드 권한 충족 + 문서 1MB 이하 |
| 파일 수정 | `folder` 필드(폴더 이동)만 허용 — 업로더 위조 등 메타 변조 차단 |
| 파일 삭제 | 업로더 본인 또는 방장만 |

⚠️ 규칙 적용 후에는 **이전에 localStorage ID로 만들어진 방의 방장 권한이 끊깁니다** (uid 기준으로 바뀌므로). 기존 테스트 방은 만료로 정리하면 됩니다.

### 3. TTL 정책 (만료 데이터 자동 삭제)
콘솔 → **Firestore Database → TTL** → 정책 추가:
- 컬렉션 그룹 `rooms`, 필드 `expiresAt`
- 컬렉션 그룹 `images`, 필드 `expiresAt` (이미지 문서에도 만료 시각이 복제 저장되어 있음)

## 코드에 적용되어 있는 보안 조치

- **XSS 방지**: 사용자 입력(닉네임/파일명/폴더명)은 `escapeHtml`로 이스케이프 후 렌더링
- **입장 암호**: 원문 저장 없이 SHA-256 해시만 저장, 방 코드를 salt로 사용 (레인보우 테이블 방지)
- **보안 헤더** (`vercel.json`): CSP(허용된 CDN·Firebase 도메인만), X-Frame-Options(클릭재킹 방지), nosniff, Referrer-Policy, Permissions-Policy

## 남아 있는 한계 (실서비스 전 알아야 할 것)

1. **입장 암호는 데모 수준입니다.** 방 문서가 공개 읽기라서 해시 값 자체는 누구나 조회할 수 있고, 검증도 클라이언트에서 합니다. 실서비스라면 Cloud Functions 등 서버 측 검증이 필요합니다.
2. **방 코드가 곧 접근 권한입니다.** 8자리 코드를 아는 사람은 누구나 열람 가능 — 링크 공유 모델의 의도된 동작이지만, 민감한 사진에는 부적합합니다.
3. **읽기 제한 없음**: 규칙상 read는 공개입니다(링크 입장 모델 유지 목적). 읽기까지 통제하려면 참여자 등록 + 규칙 검증 구조가 필요합니다.
4. **Base64 저장 구조**: 파일이 DB 문서에 들어가므로 용량·비용에 취약합니다. Firebase Storage 전환 시 Storage 규칙도 별도로 작성해야 합니다.
