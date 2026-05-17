# ElectroMesh Microagent — MVP → Production

## 문제 (현재 MVP가 사기인 이유)

[`lan pair-all`](electromesh-cli/src/commands/lan.mjs:159) 은 ICMP ping sweep + ARP cache 만으로 LAN 의 IP/MAC 을 긁어서 **본인이 본인 명의로 등록**한다. 등록되는 디바이스(스마트 TV, 냉장고, 라우터…) 는 자기가 페어링됐는지조차 모르고, 실제 sha256 work 는 게이트웨이 PC 의 worker thread 가 전부 대신 한다. [`syntheticBenchmark()`](electromesh-cli/src/commands/lan.mjs:262) 가 디바이스 클래스별로 그럴싸한 hash MH/s 숫자를 위조해서 백엔드 가격책정에 박는다.

→ **결과**: "전구가 0.001 MH/s 로 참여" 같은 청구가 가능. 실제론 노트북이 다 함.

## 목표 (Production 단계의 정직한 분산)

스마트 TV / 냉장고 / 셋톱박스 / 게임콘솔 / NAS 등 **CPU 가 진짜 있고 OS 가 도는** 디바이스에서 자체 프로세스로 work 를 실제 실행. 게이트웨이는 더 이상 대행하지 않는다.

## 아키텍처

```
┌──────────────────┐                 ┌──────────────────────────┐
│ Gateway (em CLI) │  ── discover ──▶│ Smart TV (microagent)    │
│ - LAN scan       │  ◀── /healthz ──│   ed25519 keypair        │
│ - LAN claim      │                 │   POST /v1/devices/      │
│ - simulate-iot   │                 │     register (self)      │
└──────────────────┘                 │   POST /v1/devices/{id}/ │
         │                           │     pair → device_token  │
         │                           │   POST /v1/devices/{id}/ │
         │                           │     benchmark (real CPU) │
         │                           │   loop: claim → sha256   │
         │                           │     in worker_thread →   │
         │                           │     submit signed result │
         ▼                           └──────────────────────────┘
   Backend: 동일한 /v1/devices/* /v1/agent/* 엔드포인트 재사용
```

## 변경 범위

| 컴포넌트 | 변경 |
|---|---|
| `electromesh-microagent/` (신규) | 1 프로세스 = 1 IoT 디바이스. 자체 키페어, 자체 등록, 자체 benchmark, 자체 work loop. HTTP `/healthz` 노출 (게이트웨이 발견용) |
| `electromesh-cli/src/commands/lan.mjs` | ARP-only 등록 폐기. **HTTP probe** 우선. agent 응답하는 host 만 "native_agent" 로 등록, 응답 없으면 `unreachable` 마킹 (비활성) |
| Device extras | `participation_mode`: `native_agent` / `proxy_served` / `unreachable`. 백엔드는 JSON `extras` 컬럼에 저장 (마이그레이션 불필요) |
| `electromesh-microagent/simulate.mjs` | 로컬 dev 환경에서 N 개의 마이크로에이전트를 각각 다른 포트/디바이스클래스로 spawn. 진짜 분산처럼 동작 |

## 시나리오 검증 흐름

1. `node electromesh-microagent/simulate.mjs 4` → 4 프로세스 spawn (smart_tv, fridge, console, nas)
2. 각 프로세스가 자기 자신을 register → pair → benchmark
3. `em lan pair-all` 은 이제 등록 대신 **검증** 만: 응답하는 endpoint 가 백엔드에 등록된 device 와 일치하는지 확인
4. `em scenario vault-password` 제출
5. dispatcher 가 4 디바이스로 workunit 분산
6. 각 프로세스의 stdout 로그에서 자기가 받은 chunk 가 보임 → **진짜 분산처리**

## 보안/철학

- 게이트웨이가 IoT 의 user_token 을 가지면 안 됨. v1 dev 모드에선 env var 로 패스 (편의), v2 에선 **pairing code**(QR/PIN 입력) 로 IoT 가 직접 백엔드 인증
- 응답 없는 ARP host 는 등록 거부. 사기 차단
- benchmark 는 디바이스 자체 CPU 로 측정 (`runBenchmark()` 재사용)
