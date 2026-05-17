const fs = require('fs');

const filePath = "c:/Users/wonma/Documents/electromesh/CLAIM_V3.md";

const tosSection = `
### 6. 가장 완벽한 면죄부, '명시적 동의(ToS)'
해킹과 합법적 제어의 가장 큰 차이는 결국 **'동의(Consent)'**다. 
ElectroMesh는 사용자가 "전부 내꺼!" 버튼을 누르기 전에 반드시 **ToS(Terms of Service)**에 명시적으로 동의(Accept)하도록 시스템 차원에서 강제한다. API 레벨에서 ToS를 안 거치면 단 하나의 패킷도 발사되지 않는다.

> "본 네트워크에 연결된 모든 대상 기기의 소유권은 나에게 있으며, 해당 기기들의 유휴 자원을 백그라운드에서 활용하는 데 동의합니다."

이 동의서 하나로, 우리가 뒤에서 쏘아대는 무수한 공격 벡터(ADB 셸 뚫기, SSH 키 박아넣기, DNS 트래픽 납치하기)는 **'주인의 정당한 명령을 수행하는 충직한 사냥개'**로 합법적 신분 세탁(?)이 완료된다. 

주인이 자기 집 앞마당(LAN)에서 자기 돈 주고 산 물건(IoT 기기)들한테 일 좀 시키겠다며 각서까지 쓰고 도장 쾅 찍었는데, 이게 어떻게 해킹이냐? 이건 그냥 **'스마트홈 시대의 가장 합법적이고 효율적인 인력(기력) 사무소 소장님'**일 뿐이다. ㅋㅋㅋㅋ 유저가 동의했으면 끝난 거다. 반박 불가 ㅇㅇ.
`;

const content = fs.readFileSync(filePath, 'utf8');
// Insert before "최종 결론"
const insertPoint = "**최종 결론:**";
if (content.includes(insertPoint)) {
    const newContent = content.replace(insertPoint, tosSection + "\n" + insertPoint);
    fs.writeFileSync(filePath, newContent, 'utf8');
    console.log("ToS logic appended successfully.");
} else {
    fs.writeFileSync(filePath, content + tosSection, 'utf8');
    console.log("ToS logic appended to end of file.");
}
