/** A normalised web source. `index` is the 1-based citation number. */
export interface SearchSource {
  index: number;
  url: string;
  title: string;
  snippet: string;
  domain: string;
  publishedAt: string | null;
}

export interface SearchProviderResult {
  provider: string;
  sources: SearchSource[];
}
