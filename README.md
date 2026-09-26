# 📚 studylida

> 공부한 컴퓨터 사이언스 및 웹 기술 개념을 기록하고 연결하는 개인 기술 블로그입니다.  
> 🔗 **배포 주소:** [https://studylida.github.io](https://studylida.github.io)

---

## 📌 프로젝트 소개

학습한 지식을 정리하고, 글과 글 사이의 연관 개념을 쉽게 탐색할 수 있도록 설계한 정적 블로그입니다.  
본문에서 특정 단어를 더블클릭하거나 드래그했을 때, 해당 키워드와 관련된 다른 글을 즉시 추천해 주는 **연관 지식 팝오버 기능**을 중심으로 제작되었습니다.

---

## 🛠️ 주요 기능

### 1. 단어 선택 연관 글 팝오버 (`KnowledgePopover`)
- 본문 텍스트를 더블클릭하거나 드래그하면 연관된 포스트 목록을 팝오버 형태로 표시
- `window.getSelection()` 및 `getBoundingClientRect()`를 사용해 선택된 단어 위치에 팝오버 배치
- 팝오버가 화면 밖으로 벗어나지 않도록 상하/좌우 뷰포트 경계 감지 및 위치 보정
- 빌드 타임에 생성된 정적 색인(`search-index.json`)을 인메모리에 캐싱하여 `태그 > 제목 > 본문` 가중치 순으로 매칭

### 2. 인터랙티브 다이어그램 캔버스 (`Mermaid.astro`)
- 블로그 본문 내에서 마우스 드래그(Pan) 및 휠 스크롤/버튼(Zoom)으로 다이어그램을 자유롭게 이동 및 확대/축소
- 노션이나 에디터에서 활용할 수 있는 **Mermaid 원본 소스 코드 복사 기능** 제공
- 대형 모니터 환경을 위한 전체화면 모달 지원

### 3. 전체 빠른 검색 (`Ctrl + K` / `Cmd + K`)
- 단축키로 호출 가능한 전역 검색 모달
- 타이핑 즉시 제목 및 태그 기반 실시간 필터링

### 4. 탐색 구조 및 목차 (TOC)
- **좌측 사이드바:** 전체 글의 카테고리 및 태그 목록 자동 집계 및 필터 페이지 링크
- **우측 목차:** `IntersectionObserver`를 활용하여 스크롤 위치에 따라 현재 읽고 있는 섹션 실시간 하이라이트

### 5. 마크다운 렌더링 지원
- **코드 블록:** Shiki 기반 문법 강조, 언어 표시 뱃지 및 원클릭 클립보드 복사 버튼
- **수식:** KaTeX 기반 인라인($...$) 및 블록($$...$$) 수식 렌더링
- **이미지 최적화:** 마크다운 상대 경로 이미지 자동 압축 및 크기 최적화

### 6. 배포 및 SEO
- **CI/CD:** `main` 브랜치 Push 시 GitHub Actions를 통해 GitHub Pages로 자동 빌드 및 배포
- **SEO/피드:** `robots.txt`, `@astrojs/sitemap` 기반 사이트맵 자동 생성, `rss.xml` 제공

---

## ✍️ 포스팅 작성 가이드 (Writing Guide)

이 블로그의 가독성과 시각적 밸런스를 유지하기 위한 글 작성 규칙입니다.

### 1. Frontmatter 규칙
* **발행 일시 (`pubDate`):** 같은 날 여러 글을 발행할 때는 시/분/초를 명시하여 정렬 순서를 보장합니다.
  ```yaml
  ---
  title: "게시글 제목"
  description: "게시글 요약 설명"
  pubDate: 2026-09-27 15:30:00 # YYYY-MM-DD HH:mm:ss 형식 권장
  tags: ["Architecture", "MSA"]
  category: "Architecture"
  draft: false
  ---
  ```
* **태그 등록:** 단어 드래그 팝오버의 매칭 정확도를 위해 핵심 키워드 3~5개를 태그로 등록합니다.

### 2. 제목(Heading) 작성 및 간결성 원칙 ⭐
* **대제목(`h2`)은 15자 내외의 명사형 키워드로 작성:**
  * 우측 목차(TOC) 사이드바(250px)에서 줄바꿈이 지저분해지거나 잘리지 않도록 핵심만 간결하게 축약합니다.
  * ❌ *지양:* `## 3. 인프라 통신 뼈대: Nacos와 2단계 라우팅(2-Tiered Routing) 실전 구현 가이드`
  * ⭕ *권장:* `## 3. 인프라 통신 뼈대와 Nacos 라우팅`
* **상세 설명이나 부제는 제목 바로 아래 첫 문장에 서술합니다.**

### 3. 코드 블록 및 다이어그램
* 코드 블록은 반드시 언어를 명시(` ```typescript `, ` ```mermaid `)하여 언어 뱃지와 복사 버튼, 인터랙티브 캔버스가 활성화되도록 합니다.

### 4. 이미지 첨부
* 이미지는 `src/assets/`에 저장하고 상대 경로(`![설명](../../assets/파일명.png)`)로 불러와 Astro의 자동 압축 최적화(WebP 변환)를 적용받도록 합니다.

---

## ⚙️ 기술 스택 및 선택 이유

* **Astro 5:** 정적 콘텐츠 중심 사이트에 적합하며, 필요한 인터랙션 컴포넌트에만 스크립트를 전달할 수 있는 구조
* **Content Collections (Zod):** 마크다운 메타데이터(Frontmatter)의 빌드 타임 타입 검증
* **TypeScript:** 엄격한 타입 체크를 통한 안정적인 검색/매칭 로직 작성
* **Tailwind CSS:** 유틸리티 클래스 기반 레이아웃 및 `@tailwindcss/typography`를 통한 마크다운 스타일링

---

## 📁 디렉터리 구조

```text
src/
├── components/
│   ├── blog/              # CategorySidebar, TOC, PostCard, CodeCopy, Mermaid
│   └── interactive/       # KnowledgePopover (드래그 팝오버), SearchModal (검색 모달)
├── content/
│   ├── config.ts          # Zod 스키마 정의 (title, tags, category 등)
│   └── posts/             # 마크다운 포스트 (.md)
├── layouts/
│   └── BaseLayout.astro   # 공통 레이아웃 (헤더, 푸터, 전역 모달)
├── lib/
│   ├── knowledgeEngine.ts # 색인 fetch 및 가중치 매칭 검색 로직
│   └── utils.ts           # 정렬(sortPosts) 및 날짜 포맷 함수
├── pages/
│   ├── index.astro        # 메인 홈 목록
│   ├── posts/[...slug].astro  # 포스트 상세 페이지
│   ├── tags/[tag].astro   # 태그별 필터 페이지
│   ├── category/[category].astro # 카테고리별 필터 페이지
│   ├── rss.xml.ts         # RSS 피드
│   └── api/
│       └── search-index.json.ts # 정적 지식 색인 API
└── styles/
    └── global.css         # 글로벌 스타일, 타이포그래피 줄바꿈 및 부드러운 스크롤
```

---

## 💻 로컬 실행 방법

```bash
# 의존성 설치
npm install

# 개발 서버 실행
npm run dev

# 프로덕션 빌드
npm run build
```