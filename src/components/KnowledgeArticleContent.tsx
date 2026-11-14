import type { KnowledgeFields } from './knowledge-authoring-helpers';

export function KnowledgeArticleContent({ article }: { article: KnowledgeFields }) {
  return (
    <dl className="knowledge-authoring-content">
      <div>
        <dt>Title</dt>
        <dd>{article.title}</dd>
      </div>
      <div>
        <dt>Category</dt>
        <dd>{article.category}</dd>
      </div>
      <div>
        <dt>Article content</dt>
        <dd>{article.body}</dd>
      </div>
    </dl>
  );
}
