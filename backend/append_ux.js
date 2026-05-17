const fs = require('fs');

const filePath = "c:/Users/wonma/Documents/electromesh/CLAIM_V3.md";

const newSection = `
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
`;

const content = fs.readFileSync(filePath, 'utf8');
// Insert before "최종 결론"
const insertPoint = "**최종 결론:**";
if (content.includes(insertPoint)) {
    const newContent = content.replace(insertPoint, newSection + "\n" + insertPoint);
    fs.writeFileSync(filePath, newContent, 'utf8');
    console.log("UX philosophy appended to manifesto successfully.");
} else {
    fs.writeFileSync(filePath, content + newSection, 'utf8');
    console.log("UX philosophy appended to end of file.");
}
