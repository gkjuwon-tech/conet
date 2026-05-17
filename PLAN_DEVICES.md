# 🚀 ElectroMesh: 전용 루트 확장 계획 (Full Integration Plan)

## 🎯 목표
아이폰(Safari)에서만 작동하던 전용 루트(PWA Agent)를 모든 스마트 기기(TV, 냉장고, 전자레인지 등)로 확장하여 진정한 '분산형 전산 자원 공유'를 실현한다.

## 🛠️ 작업 목록

### 1단계: 아이폰/폰 전용 루트 UI 마무리 (진행 중)
- [x] Electron 앱 내 `PhoneAgent.tsx` 페이지 생성
- [x] QR 코드 생성 라이브러리(`qrcode.react`) 도입
- [x] 사이드바 메뉴 연동 (`/phones`)
- [ ] **(To Do)** 대시보드에서 폰 에이전트 상태 요약 보기 추가

### 2단계: 'Web Agent' 범용화 (The "Every Device" Route)
- [ ] `electromesh-phone-agent` 프로젝트를 `electromesh-web-agent`로 리브랜딩
- [ ] `index.html` 내의 문구 및 아이콘을 기기에 따라 동적으로 변하게 수정
- [ ] 저사양 브라우저(Tizen, webOS 등)를 위한 JS Web Worker 최적화

### 3단계: 백엔드 및 서비스 레이어 개조
- [ ] `DeviceClass`별 `capabilities` 검증 로직 수정 (`sha256` 허용 범위 확대)
- [ ] `Heartbeat` 처리 로직에서 브라우저 기반 에이전트 식별자 추가
- [ ] 기기별 수익 배분율(Economics) 재산정 (IoT 기기는 전력 효율이 낮으므로 보정 필요)

### 4단계: CLI 연동 및 검증
- [ ] `em lan pair-all` 시 Web-link 생성 옵션 추가
- [ ] `em device web-link <device_id>` 명령어 구현
- [ ] 실제 TV/냉장고 시뮬레이션을 통한 동작 검증

## 🔄 워크플로우
1. 사용자가 **"계속"** 입력
2. 위 목록 중 하나를 선택하여 백엔드/프론트엔드/CLI 전체 통합 구현
3. CLI 테스트를 통해 검증
4. 다음 단계 대기
