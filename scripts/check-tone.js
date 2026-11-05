/**
 * scripts/check-tone.js
 * 
 * 엔지니어링 블로그 포스트 및 동반 문서의 어조(Sober Tone) 및 UI 규격(TOC Heading Length) 자동 검증 스크립트.
 * 
 * 검사 항목:
 * 1. 과장되고 감정적인 메타포 / 금지어(27종+) 전수 검사
 * 2. 250px 우측 TOC 사이드바 최적화를 위한 h2 대제목 글자 수 (순수 제목 기준 13~16자 내외, 최대 20자) 검사
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// 1. 검사 대상 디렉터리 목록
const targetDirs = [
  path.resolve(__dirname, '../src/content/posts'),
  path.resolve(__dirname, '../docs'),
  path.resolve(__dirname, '../../Cost-Effective Microservice Incident Diagnosis Balancing Telemetry Pruning Budget and RCA Faithfulness with Fine-Tuned Qwen-7B/docs')
].filter(d => fs.existsSync(d));

// 2. 금지된 과장/자극적 메타포, 번역투 수식어 및 일상 비유 목록
const bannedKeywords = [
  '아수라장', '비명', '피눈물', '칼날', '재앙', '파멸', '혼란',
  '지옥', '참사', '족쇄', '사망', '지혈', '민낯', '사투',
  '격파', '폭발', '감옥', '세금', '기만', '급사', '종착역',
  '환상', '참담', '처참', '비극', '괴물', '마법', '저주',
  '초고속', '초극대', '원천 차단', '원천 방어', '양날의 검', '블랙홀',
  '전화번호부', '관제탑', '바구니', '완벽 정복', '심층 해부', '심층 분석',
  '유령', '나비효과', '공짜 점심', '실무 팁', '실무 함정', '실무 인사이트',
  '전수 조사', '알고리즘 군', '심각한 지연', '극명하게', '덩그러니', '통째로 증발', '프롬프트 접지'
];

// 3. 금지된 마크다운/문장 패턴 정규식
const bannedRegexes = [
  {
    type: 'BROKEN_QUOTE_EMPHASIS',
    regex: /(?<!\*)\*["“”']|["“”']\*(?!\*)/,
    desc: '따옴표와 별표(*) 기울임 결합 금지 (*"..."* 표기 시 별표 노출 버그 발생)'
  },
  {
    type: 'MIDDLE_DOT_STACK',
    regex: /[가-힣A-Za-z0-9]+·[가-힣A-Za-z0-9]+·[가-힣A-Za-z0-9]+/,
    desc: '가운뎃점(·) 3개 이상 연속 명사 나열 금지 (자연스러운 문장으로 풀어서 서술)'
  }
];

// '기적', '기만' 등 단어의 정상 기술 용어 및 조사 결합 허용 패턴
function isAllowedContext(keyword, line) {
  if (keyword === '기적') {
    const stripped = line.replace(/(주기적|정기적|비동기적|동기적)/g, '');
    return !stripped.includes('기적');
  }
  if (keyword === '기만') {
    // '크기만', '여기만', '동기만', '생기만' 등 앞 글자에 받침이 없거나 일반 명사+조사 '만' 결합 방어
    const stripped = line.replace(/([가-힣]기)만/g, '');
    return !stripped.includes('기만');
  }
  return false;
}

let totalFilesChecked = 0;
let totalViolations = 0;
const violations = [];

console.log('======================================================');
console.log('🔍 [Lint Tone & Heading] 검증을 시작합니다...');
console.log('======================================================\n');

for (const dir of targetDirs) {
  const dirName = path.basename(dir);
  const files = fs.readdirSync(dir).filter(f => f.endsWith('.md'));

  for (const file of files) {
    // 프롬프트 및 가이드 자체 정의 파일은 금지어 정의를 포함하므로 검사에서 제외
    if (file === 'BLOG_WRITING_PROMPT.md') continue;

    totalFilesChecked++;
    const filePath = path.join(dir, file);
    const content = fs.readFileSync(filePath, 'utf8');
    const lines = content.split('\n');

    const isPost = dir.includes('posts');

    lines.forEach((rawLine, idx) => {
      const lineNum = idx + 1;
      const line = rawLine.trim();

      // (1) 금지어 검사
      for (const kw of bannedKeywords) {
        if (line.includes(kw)) {
          if (!isAllowedContext(kw, line)) {
            totalViolations++;
            violations.push({
              file: `${dirName}/${file}`,
              lineNum,
              type: 'BANNED_KEYWORD',
              message: `금지된 과장 메타포 발견 [${kw}]: "${line}"`
            });
          }
        }
      }

      // (1-b) 정규식 패턴 검사 (코드 블록 라인 제외)
      if (!line.startsWith('```') && !line.startsWith('    ')) {
        for (const rule of bannedRegexes) {
          if (rule.regex.test(line)) {
            totalViolations++;
            violations.push({
              file: `${dirName}/${file}`,
              lineNum,
              type: rule.type,
              message: `${rule.desc}: "${line}"`
            });
          }
        }
      }

      // (2) h2 대제목 길이 검사 (src/content/posts 대상 필수)
      if (isPost) {
        const h2Match = line.match(/^##\s+(.+)$/);
        if (h2Match) {
          const headingText = h2Match[1].trim();
          // 마크다운 문법 제거
          let cleanHeading = headingText.replace(/\[(.*?)\]\(.*?\)/g, '$1').replace(/[`*]/g, '');
          // 순수 제목 텍스트 추출 (앞의 "1. ", "## " 등 번호 prefix 제거)
          const pureTitle = cleanHeading.replace(/^\d+[\.\)]\s*/, '').trim();
          const titleLen = pureTitle.length;

          // 250px TOC 규격: 공백 제외 글자 수 최대 13자(공백 포함 최대 16자), 레거시 포스트는 최대 20자
          const nonSpaceLen = pureTitle.replace(/\s+/g, '').length;
          if (file.startsWith('rag-series-') ? (nonSpaceLen > 13 || titleLen > 16) : titleLen > 20) {
            totalViolations++;
            violations.push({
              file: `${dirName}/${file}`,
              lineNum,
              type: 'HEADING_TOO_LONG',
              message: `h2 대제목 길이 초과 (순수 제목 ${titleLen}자, 공백 제외 ${nonSpaceLen}자): "## ${cleanHeading}" (순수 제목: "${pureTitle}")`
            });
          }
        }
      }
    });
  }
}

// 검증 결과 리포팅
if (totalViolations > 0) {
  console.error(`❌ 검증 실패: 총 ${totalViolations}건의 위반 사항이 발견되었습니다.\n`);
  violations.forEach((v, i) => {
    console.error(`${i + 1}. [${v.type}] ${v.file}:${v.lineNum}`);
    console.error(`   ${v.message}\n`);
  });
  console.error('👉 README.md의 [포스팅 작성 가이드] 및 [금지 표현 vs 권장 표현 대조표]를 참조하여 수정하세요.');
  process.exit(1);
} else {
  console.log(`✅ [PASS] 총 ${totalFilesChecked}개 문서(포스트 및 docs) 검증 완료.`);
  console.log('   - 과장 메타포(27종+): 0건');
  console.log('   - h2 대제목 TOC 규격 (순수 제목 13~16자 내외, 최대 20자): 전체 준수\n');
  process.exit(0);
}
