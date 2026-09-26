// src/lib/knowledgeEngine.ts

// 1. 인덱스 데이터 타입 정의
export interface PostIndexItem {
  slug: string;
  title: string;
  description: string;
  tags: string[];
  categories: string[];
  category?: string;
}

// 2. 검색 매칭 결과 타입 정의
export interface MatchResult {
  post: PostIndexItem;
  score: number;
  matchedReason: string; // 왜 추천되었는지 사용자에게 보여줄 뱃지 (예: '#JavaScript 태그 일치')
}

// 최초 1회 로드 후 메모리에 보관할 캐시 변수
let cachedIndex: PostIndexItem[] | null = null;

/**
 * 1단계에서 만든 search-index.json을 가져와 메모리에 캐싱합니다.
 */
export async function getSearchIndex(): Promise<PostIndexItem[]> {
  if (cachedIndex) return cachedIndex;

  try {
    const response = await fetch('/api/search-index.json');
    if (!response.ok) throw new Error('Search index load failed');
    cachedIndex = await response.json();
    return cachedIndex || [];
  } catch (error) {
    console.error('지식 색인을 불러오는 중 오류 발생:', error);
    return [];
  }
}

/**
 * 선택된 검색어(단어)와 연관된 글들을 가중치 점수 순으로 찾아냅니다.
 * 
 * @param query 사용자가 더블클릭/드래그한 단어
 * @param currentSlug 현재 읽고 있는 포스트의 slug (추천에서 제외하기 위함)
 * @param limit 최대 추천 개수 (기본 3개)
 */
export function findRelatedPosts(
  query: string,
  posts: PostIndexItem[],
  currentSlug: string = '',
  limit: number = 3
): MatchResult[] {
  const cleanQuery = query.trim().toLowerCase();

  // 검색어가 2글자 미만이거나 공백이면 추천하지 않음
  if (!cleanQuery || cleanQuery.length < 2) {
    return [];
  }

  const results: MatchResult[] = [];

  for (const post of posts) {
    // 현재 읽고 있는 글은 추천에서 제외
    if (currentSlug && post.slug === currentSlug) {
      continue;
    }

    let score = 0;
    let matchedReason = '';

    const lowerTitle = post.title.toLowerCase();
    const lowerDesc = post.description.toLowerCase();

    // 1순위: 태그와 정확히 또는 부분 일치하는가? (+15점)
    const matchedTag = post.tags.find((tag) => {
      const lowerTag = tag.toLowerCase();
      return lowerTag === cleanQuery || lowerTag.includes(cleanQuery) || cleanQuery.includes(lowerTag);
    });

    if (matchedTag) {
      score += 15;
      matchedReason = `#${matchedTag} 태그 일치`;
    }

    // 카테고리 일치 (+12점)
    const postCategories = post.categories || (post.category ? [post.category] : []);
    const matchedCategory = postCategories.find((cat) => {
      const lowerCat = cat.toLowerCase();
      return lowerCat === cleanQuery || lowerCat.includes(cleanQuery) || cleanQuery.includes(lowerCat);
    });
    if (matchedCategory && !matchedReason) {
      score += 12;
      matchedReason = `[${matchedCategory}] 카테고리`;
    }

    // 2순위: 제목에 키워드가 포함되어 있는가? (+8점)
    if (lowerTitle.includes(cleanQuery)) {
      score += 8;
      if (!matchedReason) matchedReason = '제목 키워드 일치';
    }

    // 3순위: 요약 설명에 포함되어 있는가? (+4점)
    if (lowerDesc.includes(cleanQuery)) {
      score += 4;
      if (!matchedReason) matchedReason = '본문 키워드 연관';
    }

    // 점수가 1점 이상인 경우만 결과 목록에 추가
    if (score > 0) {
      results.push({
        post,
        score,
        matchedReason,
      });
    }
  }

  // 점수가 높은 순(내림차순)으로 정렬하고 상위 N개만 반환
  return results.sort((a, b) => b.score - a.score).slice(0, limit);
}

/**
 * 검색 모달용: 글자 수 제한 없이 전체 글에서 키워드를 검색합니다.
 */
export function searchAllPosts(
  query: string,
  posts: PostIndexItem[],
  limit: number = 8
): MatchResult[] {
  const cleanQuery = query.trim().toLowerCase();
  if (!cleanQuery) return [];

  const results: MatchResult[] = [];

  for (const post of posts) {
    let score = 0;
    let matchedReason = '';

    const lowerTitle = post.title.toLowerCase();
    const lowerDesc = post.description.toLowerCase();

    // 1순위: 태그 일치 (+15점)
    const matchedTag = post.tags.find((t) => t.toLowerCase().includes(cleanQuery));
    if (matchedTag) {
      score += 15;
      matchedReason = `#${matchedTag} 태그`;
    }

    // 카테고리 일치 (+12점)
    const postCategories = post.categories || (post.category ? [post.category] : []);
    const matchedCat = postCategories.find((c) => c.toLowerCase().includes(cleanQuery));
    if (matchedCat && !matchedReason) {
      score += 12;
      matchedReason = `[${matchedCat}] 카테고리`;
    }

    // 2순위: 제목 일치 (+8점)
    if (lowerTitle.includes(cleanQuery)) {
      score += 8;
      if (!matchedReason) matchedReason = '제목 일치';
    }

    // 3순위: 요약 설명 일치 (+4점)
    if (lowerDesc.includes(cleanQuery)) {
      score += 4;
      if (!matchedReason) matchedReason = '내용 일치';
    }

    if (score > 0) {
      results.push({ post, score, matchedReason });
    }
  }

  return results.sort((a, b) => b.score - a.score).slice(0, limit);
}