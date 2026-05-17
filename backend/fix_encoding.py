import os

file_path = "c:/Users/wonma/Documents/electromesh/CLAIM_V3.md"

with open(file_path, "r", encoding="utf-8", errors="replace") as f:
    lines = f.readlines()

# Find where the garbage starts
target_index = -1
for i, line in enumerate(lines):
    if "Future Roadmap" in line or "Post-Mortem" in line or "??" in line:
        if i > 65:  # just to be safe
            target_index = i
            break

if target_index != -1:
    lines = lines[:target_index]

correct_text = """
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
"""

with open(file_path, "w", encoding="utf-8") as f:
    f.writelines(lines)
    f.write(correct_text)

print("Fixed CLAIM_V3.md encoding.")
