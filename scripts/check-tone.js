/**
 * scripts/check-tone.js
 * 
 * 엔지니어링 블로그 포스트 및 동반 문서의 어조(Sober Tone) 및 UI 규격(TOC Heading Length) 자동 검증 스크립트.
 * 
 * 검사 항목:
 * 1. 과장되고 감정적인 메타포 / 금지어 전수 검사
 * 2. 신규 DKM 시리즈의 가운뎃점(·) 금지 및 백틱 내 '\~' 이스케이프 검사
 * 3. 250px 우측 TOC 사이드바 최적화를 위한 h2 대제목 글자 수 검사 (rag-series 및 신규 dkm-series: 공백 제외 13자/포함 16자, 레거시: 최대 20자)
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
  '전수 조사', '알고리즘 군', '심각한 지연', '극명하게', '덩그러니', '증발', '프롬프트 접지',
  '못 박', '못박', '쥐고', '꼬이', '꼬여'
];

// 3. 금지된 마크다운/문장 패턴 정규식
const bannedRegexes = [
  {
    type: 'BROKEN_QUOTE_EMPHASIS',
    regex: /(?<!\*)\*["“”']|["“”']\*(?!\*)|(?<!_)_["“”']|["“”']_(?!_)/,
    desc: '따옴표와 별표(*) 또는 밑줄(_) 기울임 결합 금지 (*"..."* 표기 시 기호 노출 버그 발생)'
  },
  {
    type: 'MIDDLE_DOT_STACK',
    regex: /[가-힣A-Za-z0-9]+(?:\s*·\s*)[가-힣A-Za-z0-9]+(?:\s*·\s*)[가-힣A-Za-z0-9]+/,
    desc: '가운뎃점(·) 3개 이상 연속 명사 나열 금지 (자연스러운 문장으로 풀어서 서술)'
  }
];

function stripInlineCode(line) {
  return line.replace(/(`+)([\s\S]*?)\1/g, '');
}

function findInlineBacktickEscapes(line) {
  const matches = [];
  const re = /(`+)([\s\S]*?)\1/g;
  let m;
  while ((m = re.exec(line)) !== null) {
    if (m[2].includes('\\~')) {
      matches.push(m[0]);
    }
  }
  return matches;
}

function stripQuotedCodeStrings(line) {
  return line.replace(/'(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*"/g, '');
}

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
    // 신규 DKM 시리즈(5~9+편)는 강화된 규칙(가운뎃점 전면 금지, 백틱 이스케이프 금지, 엄격한 TOC 길이)을 적용한다.
    const isModernDkm = isPost && /^dkm-series-part(?:[5-9]|\d{2,})-/.test(file);
    let fenceToken = null;

    lines.forEach((rawLine, idx) => {
      const lineNum = idx + 1;
      const line = rawLine.trim();
      const fenceMatch = line.match(/^(`{3,}|~{3,})/);
      if (fenceMatch) {
        const token = fenceMatch[1];
        if (!fenceToken) {
          fenceToken = token;
          return;
        }
        if (token[0] === fenceToken[0] && token.length >= fenceToken.length && line === token) {
          fenceToken = null;
          return;
        }
      }
      const inFence = fenceToken !== null;
      const isIndentedCode = !inFence && /^ {4,}/.test(rawLine) && !/^\s{4,}(?:[-*+]|\d+\.)\s/.test(rawLine);

      // (1) 금지어 검사 (코드 블록 제외)
      if (!inFence && !isIndentedCode) {
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
      }

      // (1-b) 정규식 패턴 검사 (코드 블록·인라인 코드 제외)
      if (!inFence && !isIndentedCode) {
        const plainLine = stripInlineCode(line);
        for (const rule of bannedRegexes) {
          const target = rule.type === 'BROKEN_QUOTE_EMPHASIS' ? plainLine.replace(/\\[*_]/g, '') : line;
          if (rule.regex.test(target)) {
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

      // (1-c) 신규 DKM 시리즈 엄격 검사: 가운뎃점(·) 금지(원천 코드의 문자열 리터럴 제외) 및 '\~' 백틱·주석 오용 검사
      if (isModernDkm) {
        const dotCheckTarget = inFence ? stripQuotedCodeStrings(line) : line;
        if (dotCheckTarget.includes('·')) {
          totalViolations++;
          violations.push({
            file: `${dirName}/${file}`,
            lineNum,
            type: 'MIDDLE_DOT_FORBIDDEN',
            message: `신규 DKM 포스트에서는 가운뎃점(·) 사용을 금지합니다: "${line}"`
          });
        }
        if (!inFence && findInlineBacktickEscapes(line).length > 0) {
          totalViolations++;
          violations.push({
            file: `${dirName}/${file}`,
            lineNum,
            type: 'BACKTICK_ESCAPE',
            message: `인라인 코드 백틱 안에서 '\\~' 이스케이프를 쓰지 마세요: "${line}"`
          });
        }
        if (inFence && line.startsWith('#') && line.includes('\\~')) {
          totalViolations++;
          violations.push({
            file: `${dirName}/${file}`,
            lineNum,
            type: 'CODE_COMMENT_ESCAPE',
            message: `코드 블록 주석 안에서 '\\~' 마크다운 이스케이프를 쓰지 마세요: "${line}"`
          });
        }
      }

      // (2) 시리즈 제목 일관성 및 h2 대제목 길이 검사 (src/content/posts 대상, 코드 블록 제외)
      if (isPost && !inFence && !isIndentedCode) {
        if (lineNum <= 10 && file.startsWith('rag-series-') && line.startsWith('title:')) {
          if (!/^title:\s*"RAG 파이프라인 \d+편(\(실습\))?:\s+.+"$/.test(line)) {
            totalViolations++;
            violations.push({
              file: `${dirName}/${file}`,
              lineNum,
              type: 'SERIES_TITLE_MISMATCH',
              message: `RAG 시리즈 포스트 제목은 'title: "RAG 파이프라인 N편: ..."' 또는 'title: "RAG 파이프라인 N편(실습): ..."' 형식을 따라야 합니다: ${line}`
            });
          }
        }
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
          if ((file.startsWith('rag-series-') || isModernDkm) ? (nonSpaceLen > 13 || titleLen > 16) : titleLen > 20) {
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
  console.error('👉 AGENTS.md 및 README.md의 작성 가이드를 참조하여 수정하세요.');
  process.exit(1);
} else {
  console.log(`✅ [PASS] 총 ${totalFilesChecked}개 문서(포스트 및 docs) 검증 완료.`);
  console.log(`   - 과장 메타포(${bannedKeywords.length}종) 및 문체 패턴: 0건`);
  console.log('   - h2 대제목 TOC 규격 (시리즈 공백 제외 13자/포함 16자, 기타 20자): 전체 준수\n');
  process.exit(0);
}
