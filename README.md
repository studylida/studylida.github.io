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

### 2. 전체 빠른 검색 (`Ctrl + K` / `Cmd + K`)
- 단축키로 호출 가능한 전역 검색 모달
- 타이핑 즉시 제목 및 태그 기반 실시간 필터링

### 3. 탐색 구조 및 목차 (TOC)
- **좌측 사이드바:** 전체 글의 카테고리 및 태그 목록 자동 집계 및 필터 페이지 링크
- **우측 목차:** `IntersectionObserver`를 활용하여 스크롤 위치에 따라 현재 읽고 있는 섹션 실시간 하이라이트

### 4. 마크다운 렌더링 지원
- **코드 블록:** Shiki 기반 문법 강조, 언어 표시 뱃지 및 원클릭 클립보드 복사 버튼
- **수식:** KaTeX 기반 인라인($...$) 및 블록($$...$$) 수식 렌더링
- **다이어그램:** Mermaid.js 기반 플로우차트 및 아키텍처 다이어그램 렌더링
- **이미지 최적화:** 마크다운 상대 경로 이미지 자동 압축 및 크기 최적화

### 5. 배포 및 SEO
- **CI/CD:** `main` 브랜치 Push 시 GitHub Actions를 통해 GitHub Pages로 자동 빌드 및 배포
- **SEO/피드:** `robots.txt`, `@astrojs/sitemap` 기반 사이트맵 자동 생성, `rss.xml` 제공

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
│   └── knowledgeEngine.ts # 색인 fetch 및 가중치 매칭 검색 로직
├── pages/
│   ├── index.astro        # 메인 홈 목록
│   ├── posts/[...slug].astro  # 포스트 상세 페이지
│   ├── tags/[tag].astro   # 태그별 필터 페이지
│   ├── category/[category].astro # 카테고리별 필터 페이지
│   ├── rss.xml.ts         # RSS 피드
│   └── api/
│       └── search-index.json.ts # 정적 지식 색인 API
└── styles/
    └── global.css         # 글로벌 스타일 및 부드러운 스크롤