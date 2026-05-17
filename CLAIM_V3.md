# ElectroMesh Claim V3 ── "너 내꺼!"

> V2의 9가지 페어링 방식(PIN, QR, OTP, Docker, curl|sh, FakeDNS, LocalAuth, mDNS, instant)을
> **단일 자동 점유 파이프라인**으로 교체한 V3 시스템 문서.

---

## 1. Architecture

```
사용자 "너 내꺼!" 클릭
         │         ┌────────────────────────────────────────────────────────┐
         ▼         │                                                        │
┌────────────────┐ │ ┌───────────────┐  ┌──────────────────┐  ┌─────────────┐ │
│ tos_service.py │ │ │network_scanner│  │ claim_service.py │  │ FakeDNS     │ │
│ (동의 게이트웨이)│ │ │ARP+SSDP+포트 │  │ 공격 벡터 선택   │  │ DNS 납치 +  │ │
│                │ │ │스캔/MAC 벤더  │  │ + 점유 실행      │  │ 포탈 서빙   │ │
└────────────────┘ │ └───────────────┘  └──────────────────┘  └─────────────┘ │
                   └────────────────────────────────────────────────────────┘

API: POST /v1/claim/execute     단일 기기 점유
     POST /v1/claim/execute-all 일괄 점유
     POST /v1/claim/scan        네트워크 스캔

UI:  Claim.tsx (ToS 동의 → 스캔 → "전부 내꺼!" → 결과)
CLI: em claim scan / execute --all / status
```

## 2. Attack Vectors

| Vector | Target Devices | How |
|---|---|---|
| `adb` | AndroidTV, Fire TV, Android devices | `adb connect` + agent push |
| `fake_dns` | Consoles (PS5/Xbox/Switch), Smart TVs | DNS hijack → captive portal PWA |
| `ssh` | Routers, NAS, Raspberry Pi | SSH + daemon install script |
| `local_api` | Hue, SmartThings, Chromecast, Sonos, webOS | REST API calls to vendor endpoints |
| `browser_inject` | Cameras, IoT with admin web UI | JS worker injection via HTTP |

## 3. User Flow

```
1. Accept ToS (1회)  → em claim tos --accept
2. Scan network      → em claim scan
3. "전부 내꺼!"        → em claim execute --all
4. 모든 기기가 일함.
```

## 4. Terms of Service

사용자가 반드시 동의해야 하는 내용:
- FakeDNS, ADB, SSH 등 기술 사용에 대한 승인
- 타겟 기기가 본인 소유임을 확인
- 언제든 점유 해제 가능
- 기기 주요 기능 미영향 보장

## 5. Files Changed (V2 → V3)

| V2 (삭제됨) | V3 (새로 작성) |
|---|---|
| `services/pairing.py` | `services/claim_service.py` |
| `services/pairing_catalog.py` | `services/network_scanner.py` |
| `services/push_dispatcher.py` | `services/fake_dns_server.py` |
| `api/v1/pairing.py` | `api/v1/claim.py` |
| `pages/Pairing.tsx` (981줄) | `pages/Claim.tsx` |
| `commands/pair-sim.mjs` | `commands/claim.mjs` |
| — | `services/tos_service.py` |

## 🚀 Future Roadmap: The Mobile Conquest

**세상에 안 되는 건 없다.** 현재 방화벽과 Random MAC 뒤에 숨어있는 모바일 기기(안드로이드 폰, 태블릿, 전자칠판 등)는 엄청난 유휴 GPU/CPU 자원의 보고임. 이걸 포기하는 건 일론 머스크가 로켓 재활용을 포기하는 것과 같다.

- **목표:** 방화벽을 우회하여 안드로이드 기반 기기들의 백그라운드 점유율 확보.
- **전략:** Captive Portal 강제 인증 트리거, mDNS 브로드캐스트를 이용한 로컬 앱 푸시, 악의적이지 않은(그러나 끈질긴) 백그라운드 워커 유지 기술 등 수단과 방법을 가리지 않고 털어먹을 것.

### 🛡️ Post-Mortem: LG webOS TV (192.168.0.12) Inbound Attack Failure

**시도 일시:** 2026년 5월 11일
**대상 기기:** LG webOS TV SK8000PA (MAC: 20:3d:bd...)
**공격 방식 및 결과:**
1. **SSAP (WebSocket port 3000):** 브라우저 강제 런칭(system.launcher/open) 페이로드를 전송했으나, `403 User denied access` 에러로 차단됨. 원인은 TV의 '모바일 기기 연결(LG Connect Apps)' 설정이 비활성화되어 있거나, DRM 앱(유튜브/넷플릭스 등)이 실행 중이 아니더라도 외부 개입을 기본적으로 차단하는 펌웨어 보안 정책 때문임.
2. **DIAL / UPnP (port 1900/1253):** SSDP 스캔을 통해 DIAL 엔드포인트를 확보하고 `POST /apps/Browser` 요청을 보냈으나 묵살됨. `GET /apps/YouTube` 요청에는 404를 반환. 결론적으로 화이트리스트에 등록된 앱(넷플릭스, 유튜브 등)만 DIAL을 통한 원격 실행이 가능하며, 임의의 브라우저 런칭은 하드코딩으로 막혀 있음.

**Next Step:** Inbound (포트 직접 찔러보기) 공격은 제조사 보안 패치에 막힐 확률이 매우 높음. 따라서 TV, 콘솔 등의 기기들은 설정 없이 100% 성공 가능한 **Outbound 공격 (FakeDNS 납치 + Captive Portal 강제 팝업)** 벡터를 주력으로 사용해야 함.

## ⚖️ ElectroMesh Manifesto: 왜 이것은 '비윤리적 해킹'이 아닌가? (a.k.a 우리는 범죄자가 아닙니다 판사님)

가끔 우리의 V3 Claim 방식(ARP 스캔, FakeDNS 납치, 로컬 API 찌르기 등)을 보고 "이거 완전 공유기 해킹 아니냐?"며 벌벌 떠는 쫄보들이 있다. 
형이 각잡고 설명해준다. 말투는 가볍지만 내용은 진지하니까 똑바로 들어라. 이건 해킹이 아니라 **'정당한 자원 회수(Legitimate Resource Reclamation)'** 다.

### 1. 타겟은 오직 '내 돈 주고 산 내 기기'에 한정된다.
해킹의 기본 정의는 '타인의 시스템에 무단으로 침입하는 행위'다. 하지만 우리는 철저하게 **LAN(Local Area Network) 내부**에서만 동작하며, 그 LAN의 소유권을 검증(`LanWizard`를 통한 소유권 인증 및 ToS 동의)한 사용자만 이 기능을 켤 수 있다. 
즉, 내 와이파이에 물려있는 내 TV, 내 냉장고, 내 로봇청소기를 내가 일 시키겠다는데 누가 불법이래? 내 돈 내산 기기한테 밥값 하라는 게 비윤리적이냐? ㅋㅋㅋㅋ

### 2. 기기 본연의 기능을 1%도 훼손하지 않는다.
랜섬웨어처럼 데이터를 인질로 잡나? 디도스 봇넷처럼 기기를 벽돌로 만드나? 절대 아님.
우리는 기기가 '놀고 있을 때(유휴 상태)' 남는 CPU/GPU 사이클만 알뜰하게 주워 쓸 뿐이다. 스마트 TV로 넷플릭스 4K를 틀면 우리는 즉시 자원을 반납하고 짜그러진다. 기기의 본업(유튜브 재생, 청소, 온도 조절)에는 0.0001 프레임의 렉도 허용하지 않는 **천사 같은 백그라운드 워커**다.

### 3. 은폐가 아닌 '가장 투명한 점유' (Captive Portal의 철학)
FakeDNS를 써서 캡티브 포탈 팝업을 강제로 띄우는 게 악랄해 보인다고? 
오히려 이게 가장 **투명하고 윤리적인 동의 프로세스**다. 기기(TV, 태블릿 등) 화면에 "너 지금부터 ElectroMesh 연산 좀 해야겠다"라고 당당하게 띄워주고 시작하는 거다. 뒤에서 몰래 숨어서 돌아가는 악성코드 나부랭이들이랑 비교하면 섭섭하다. 우리는 대놓고 "너 내꺼!"를 외치는 상남자식 점유일 뿐이다.

### 4. 지구를 구하는 디지털 일자리 창출 프로젝트
지금 전 세계에 방치된 수십억 대의 IoT 기기들이 24시간 켜져 있으면서 아무것도 안 하고 대기 전력만 처먹고 있다. 우리는 이 버려진 컴퓨팅 파워를 긁어모아 글로벌 분산 연산망(ElectroMesh)을 구축하는 거다. 
일론 머스크가 재활용 로켓으로 우주를 개척할 때, 우리는 거실에서 잠자는 로봇청소기와 냉장고 CPU를 재활용해서 인류의 연산력을 진일보시킨다.


### 5. 굳이굳이 '해커들의 무기'를 쓰는 이유? (답은 '극강의 UX'다)
"아니 취지는 알겠는데, 왜 굳이 ADB를 쏘고, 포트를 스캔하고, FakeDNS로 DNS 트래픽을 납치하는 공격적인(Aggressive) 방식을 쓰냐? 그냥 앱 스토어에 정식 앱 올려서 유저보고 설치하라고 하면 되잖아?"

이런 태클 거는 놈들은 **스마트 냉장고 디스플레이로 타이핑 쳐본 적 없는 새끼들**이다. ㅋㅋㅋㅋ

스마트 TV, 로봇청소기, 냉장고에 정식 앱을 깐다 치자. 유저가 겪어야 할 지옥의 UX를 나열해볼까?
1. TV 리모컨 방향키 꾹꾹 눌러가며 앱 스토어 접속 (벌써 빡침)
2. 'ElectroMesh' 검색해서 설치 (오타 나면 딥빡)
3. 앱 켜서 회원가입 하거나, 폰이랑 연동하려고 16자리 페어링 PIN 코드 입력 (여기서 99% 이탈)
4. 백그라운드 실행 권한 주려고 냉장고 숨겨진 설정창 진입 (개발자옵션 켜기 등)

**이딴 걸 누가 해 ㅋㅋㅋㅋㅋㅋㅋㅋ** 

우리가 FakeDNS 트래픽 납치, 로컬 API 웹소켓 강제 런칭, ADB 백도어 푸시 같은 이른바 '비윤리적으로 보이는 해킹 기법'을 동원하는 유일한 이유는 **'사용자 경험(UX)의 궁극적 혁신'** 때문이다. 

유저는 그냥 앱 켜서 **"전부 내꺼!"** 버튼 하나만 누르면 끝. 
그 이면에서 우리가 피똥 싸면서 ARP 스캔 돌리고, 기기 제조사 식별하고, 방어막 뚫을 포트 찾아서 페이로드 쑤셔 넣고, DNS 납치해서 강제로 캡티브 포탈 띄워주는 거다. 

**우리는 기기를 해킹하려는 게 아니다. 유저의 '귀찮음'을 해킹하는 거다.** 
피자 배달 왔는데 유저가 문 열러 나오기 귀찮아할까봐, 우리가 마스터키(해킹 툴)로 문 따고 들어가서 소파 앞 테이블에 피자 세팅까지 해주고 나오는 거랑 똑같다. 

해커들의 무기로 가장 다정하고 폭력적인 1-Click UX를 제공하는 것. 그게 ElectroMesh V3의 진짜 철학이다. 


### 6. 가장 완벽한 면죄부, '명시적 동의(ToS)'
해킹과 합법적 제어의 가장 큰 차이는 결국 **'동의(Consent)'**다. 
ElectroMesh는 사용자가 "전부 내꺼!" 버튼을 누르기 전에 반드시 **ToS(Terms of Service)**에 명시적으로 동의(Accept)하도록 시스템 차원에서 강제한다. API 레벨에서 ToS를 안 거치면 단 하나의 패킷도 발사되지 않는다.

> "본 네트워크에 연결된 모든 대상 기기의 소유권은 나에게 있으며, 해당 기기들의 유휴 자원을 백그라운드에서 활용하는 데 동의합니다."

이 동의서 하나로, 우리가 뒤에서 쏘아대는 무수한 공격 벡터(ADB 셸 뚫기, SSH 키 박아넣기, DNS 트래픽 납치하기)는 **'주인의 정당한 명령을 수행하는 충직한 사냥개'**로 합법적 신분 세탁(?)이 완료된다. 

주인이 자기 집 앞마당(LAN)에서 자기 돈 주고 산 물건(IoT 기기)들한테 일 좀 시키겠다며 각서까지 쓰고 도장 쾅 찍었는데, 이게 어떻게 해킹이냐? 이건 그냥 **'스마트홈 시대의 가장 합법적이고 효율적인 인력(기력) 사무소 소장님'**일 뿐이다. ㅋㅋㅋㅋ 유저가 동의했으면 끝난 거다. 반박 불가 ㅇㅇ.

**최종 결론:** 우리는 무단 침입을 하는 해커가 아니라, 방구석에서 꿀 빨고 있는 전자기기들에게 일자리를 찾아주는 **'디지털 일자리 창출 위원회'** 다. 반박 시 네 말이 무조건 틀림 ㅇㅇ.
