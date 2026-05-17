# 안드로이드 페어링 로컬 테스트 가이드 (아주아주 쉬운 버전)

> 형, 진짜 그대로 복붙만 하면 됨. 5분컷.
> 백엔드가 `localhost:8080`에서 돌고 있고, 안드로이드 폰이 같은 WiFi에
> 붙어있다는 가정.

---

## 0. 준비물 체크리스트

복붙 들어가기 전에 한번만 확인:

- [ ] **노트북** (백엔드 돌리는 머신) — 안드로이드 SDK 또는 `adb` 깔려있어야 함
- [ ] **안드로이드 폰** — 화면 켜져 있고 잠금 풀린 상태
- [ ] **같은 WiFi** — 노트북이랑 폰이 똑같은 WiFi에 붙어있어야 함
      (5GHz/2.4GHz가 다른 SSID이면 같은 쪽으로 맞추기)
- [ ] **백엔드** — 이미 돌고 있어야 함 (`uvicorn app.main:app --port 8080`)

---

## 1. `adb` 설치 (1분컷)

### macOS
```bash
brew install --cask android-platform-tools
adb version
```

### Linux (Ubuntu/Debian)
```bash
sudo apt-get update && sudo apt-get install -y adb
adb version
```

### Windows (PowerShell, 관리자)
```powershell
winget install --id=Google.PlatformTools -e
adb version
```

`adb version`이 버전 찍어주면 ㅇㅋ. 안 찍히면 터미널 다시 열어봐.

> 백엔드한테 다른 경로의 `adb` 쓰게 하고 싶으면:
> ```bash
> export ELECTROMESH_ADB_PATH=/path/to/your/adb
> ```

---

## 2. 안드로이드 폰 세팅 (30초컷)

폰에서:

1. **설정** → **휴대전화 정보** → **소프트웨어 정보**
2. **빌드 번호** 7번 연타 → "개발자 모드 활성화됨" 토스트
3. **설정** → **개발자 옵션** → **무선 디버깅** ON
4. **무선 디버깅** 진입 → **"페어링 코드로 기기 페어링"** 탭
5. 화면에 뜬 거 그대로 둠:
   - **WiFi 페어링 코드** (6자리 숫자) ← 이거 곧 씀
   - **IP 주소 및 포트** (예: `192.168.0.42:37411`) ← 이거도 곧 씀

> ⚠️ 페어링 코드 화면은 한번 닫으면 코드가 바뀜. 그냥 켜둔 채로 진행.

---

## 3. 백엔드한테 "내 친구들" 알려주기 (10초컷)

이게 이번에 추가된 **friend-or-foe 필터**임. 형 노트북이랑 폰을 친구로
등록하면 백엔드가 형을 공격 안 함.

먼저 로그인 토큰 얻기 (이미 있으면 스킵):
```bash
# 컨슈머 앱에서 로그인 → DevTools → localStorage.getItem('em-jwt')
# 아니면:
export EM_TOKEN="<여기에 본인 JWT>"
```

본인 IP/MAC 찾기:

### macOS / Linux
```bash
# 본인 IP
ip route get 1.1.1.1 | awk '{print $7; exit}'        # Linux
ipconfig getifaddr en0                                # macOS

# 본인 MAC (en0 = WiFi 보통)
ifconfig en0 ether 2>/dev/null | awk '/ether/{print $2}'   # macOS
ip link show wlp2s0 2>/dev/null | awk '/ether/{print $2}'  # Linux

# 게이트웨이 IP
ip route | awk '/default/{print $3; exit}'           # Linux
netstat -rn -f inet | awk '/^default/{print $2; exit}'  # macOS
```

### Windows
```powershell
ipconfig | findstr "IPv4"
ipconfig | findstr "Default Gateway"
getmac /v /fo list
```

이제 백엔드한테 등록:
```bash
curl -X POST http://localhost:8080/v1/android/friends \
  -H "Authorization: Bearer $EM_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "our_ip":      "192.168.0.10",
    "our_mac":     "aa:bb:cc:dd:ee:ff",
    "gateway_ip":  "192.168.0.1",
    "gateway_mac": "11:22:33:44:55:66",
    "friends_ip":  ["192.168.0.20"],
    "friends_mac": []
  }'
```

응답:
```json
{
  "our_ip": "192.168.0.10",
  "our_mac": "aa:bb:cc:dd:ee:ff",
  "gateway_ip": "192.168.0.1",
  "friends_ip": ["192.168.0.20"],
  "vetoed": []
}
```

이러면 형 노트북(`192.168.0.10`), 게이트웨이(`192.168.0.1`), 추가
친구(`192.168.0.20`)는 절대 공격 안 함.

---

## 4. 상태 확인 (5초컷)

```bash
curl -s http://localhost:8080/v1/android/status \
  -H "Authorization: Bearer $EM_TOKEN" | jq
```

```json
{
  "adb_available": true,
  "adb_path": "/usr/local/bin/adb",
  "stats": {"attempts": 0, "ok": 0, "failed": 0, "skipped_friend": 0},
  "foe": {...},
  "recent": [],
  "offers": [],
  "offers_age_s": null
}
```

`adb_available: true`면 ㄱㄱ. `false`면 1번으로 돌아가서 `adb` 설치
다시 확인.

---

## 5. 안드로이드 11+ 페어링 (메인 코스)

폰 화면에 있는 "**IP 주소 및 포트**" + "**WiFi 페어링 코드**" 두 개 그대로 씀.

### 5-A. mDNS 스윕 (자동 발견)
```bash
curl -X POST http://localhost:8080/v1/android/discover \
  -H "Authorization: Bearer $EM_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"force": true, "listen_seconds": 6}'
```

응답에 폰이 보여야 함:
```json
{
  "offers": [
    {
      "ip": "192.168.0.42",
      "port": 37411,
      "service": "_adb-tls-pairing._tcp.local.",
      "is_pairing": true,
      "is_connect": false
    },
    {
      "ip": "192.168.0.42",
      "port": 39501,
      "service": "_adb-tls-connect._tcp.local.",
      "is_pairing": false,
      "is_connect": true
    }
  ],
  "count": 2
}
```

> 안 보이면? 폰의 무선 디버깅 화면 닫지 말고 (그러면 mDNS 안 쏨), `force: true`로 다시 호출. 5GHz/2.4GHz mDNS 라우팅 안 되는 공유기는 가끔 그래서, 폰 한번 끄고 켰다 해보면 보통 됨.

### 5-B. PIN으로 페어링
폰 화면에 뜬 6자리 PIN (예시: `483921`)을 그대로 박음:
```bash
curl -X POST http://localhost:8080/v1/android/enroll \
  -H "Authorization: Bearer $EM_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "target_ip": "192.168.0.42",
    "pin":       "483921",
    "prefer":    "mdns_pair"
  }'
```

성공:
```json
{
  "ok": true,
  "ip": "192.168.0.42",
  "method": "mdns_pair",
  "detail": "paired+connected in 2 attempts",
  "port": 39501,
  "props": {
    "model": "SM-S921N",
    "brand": "samsung",
    "manufacturer": "samsung",
    "sdk": "34",
    "release": "14",
    "security_patch": "2024-09-01",
    "abi": "arm64-v8a",
    "is_emulator": false
  },
  "duration_ms": 1843,
  "pin_length": 6
}
```

이러면 끝. 폰 화면에서 "기기에 페어링됨"으로 바뀜.

---

## 6. 안드로이드 10 이하 / TV박스 / 파이어TV (PIN 없는 클래식 모드)

이건 폰에서 **개발자 옵션 → "네트워크를 통한 ADB"** 또는
**"무선 디버깅"** 켰을 때 PIN 없이 그냥 5555로 붙는 케이스.

```bash
curl -X POST http://localhost:8080/v1/android/enroll \
  -H "Authorization: Bearer $EM_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "target_ip": "192.168.0.42",
    "prefer":    "legacy_connect"
  }'
```

폰에 처음 한번 **"이 컴퓨터에서의 USB 디버깅을 항상 허용"** 다이얼로그가
뜸. 체크 + **허용** 누르면 끝. 다음부터는 자동.

> `unauthorized` 에러 나오면 폰 화면 확인 — 다이얼로그 그냥 떠있고 형이 안 누른 거임.

---

## 7. 배치 페어링 (여러 대 한방에)

mDNS로 발견된 모든 안드로이드 한방에:
```bash
curl -X POST http://localhost:8080/v1/android/enroll-many \
  -H "Authorization: Bearer $EM_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"pin": "483921"}'
```

특정 IP 리스트만:
```bash
curl -X POST http://localhost:8080/v1/android/enroll-many \
  -H "Authorization: Bearer $EM_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "targets": ["192.168.0.42", "192.168.0.51"],
    "prefer":  "legacy_connect"
  }'
```

응답:
```json
{
  "attempted": 3,
  "succeeded": 2,
  "failed": 0,
  "skipped_friend": 1,
  "results": [...]
}
```

`skipped_friend: 1` ← 형 노트북이 자동으로 걸러진 거임 ㅋㅋ. 이게 이번
업그레이드 핵심.

---

## 8. 페어링 후 확인

페어링된 거 확인:
```bash
adb devices
```

```
List of devices attached
192.168.0.42:39501    device
```

폰 모델 확인 (이번에 풍부해진 `getprop` 전체 덤프):
```bash
adb -s 192.168.0.42:39501 shell getprop ro.product.model
adb -s 192.168.0.42:39501 shell getprop ro.build.version.release
```

---

## 9. 트러블슈팅

### "adb binary not found"
→ 1번 단계 다시. `ELECTROMESH_ADB_PATH` 환경변수로 절대경로 지정 가능.

### `discover`에서 offer가 0개
- 폰의 **무선 디버깅 화면**이 닫혔는지 확인 (닫으면 mDNS 끔)
- 노트북이 안드로이드와 **다른 SSID/VLAN**일 가능성
- 공유기가 **mDNS 차단** 켜놓은 경우 (TP-Link AP Isolation, Mesh 가드 등) → 끄기

### `unauthorized`
→ 폰 화면 다이얼로그 누르기. **항상 허용** 체크.

### `paired but connect failed`
→ 페어링은 됐는데 connect 서비스 포트가 안 잡힌 거. 30초 기다리고 한번 더:
```bash
curl -X POST http://localhost:8080/v1/android/enroll \
  -H "Authorization: Bearer $EM_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"target_ip":"192.168.0.42","prefer":"legacy_connect"}'
```

### 특정 IP 평생 무시
```bash
curl -X POST http://localhost:8080/v1/android/friends/veto/192.168.0.77 \
  -H "Authorization: Bearer $EM_TOKEN"
```

---

## 10. 통계 / 디버깅

```bash
watch -n2 'curl -s http://localhost:8080/v1/android/status \
  -H "Authorization: Bearer $EM_TOKEN" | jq ".stats, .recent[-3:]"'
```

실시간으로 `attempts`, `ok`, `failed`, `skipped_friend` 카운터가 올라가는
거 보면 됨.

백엔드 로그도 보기:
```bash
# 백엔드 console 또는:
tail -f backend/logs/app.log | grep android_pair
```

구조화 로그 키:
- `android_pair.foe.configured`     ← friend-or-foe 설정 완료
- `android_pair.skip`               ← 친구라 스킵
- `mdns_pair.offer`                 ← 페어링 offer 발견
- `android_pair.mdns_pair.failed`   ← 페어링 실패
- `android_pair.getprop`            ← 디바이스 정보 덤프
- `android_pair.legacy.fail_all_ports` ← 5555/5554/... 다 막힘

---

## 11. 진짜 한 줄 요약

```bash
# 1. 친구 등록
curl -X POST localhost:8080/v1/android/friends -H "Authorization: Bearer $EM_TOKEN" -H "Content-Type: application/json" \
  -d '{"our_ip":"<내IP>","our_mac":"<내MAC>","gateway_ip":"<게이트웨이>"}'

# 2. 스윕
curl -X POST localhost:8080/v1/android/discover -H "Authorization: Bearer $EM_TOKEN" -H "Content-Type: application/json" \
  -d '{"force":true,"listen_seconds":6}'

# 3. 페어링 (폰 화면 PIN 그대로)
curl -X POST localhost:8080/v1/android/enroll -H "Authorization: Bearer $EM_TOKEN" -H "Content-Type: application/json" \
  -d '{"target_ip":"<폰IP>","pin":"<6자리PIN>","prefer":"mdns_pair"}'
```

끝. 5분컷 ㅋㅋㅋㅋㅋㅋ.
