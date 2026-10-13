export interface DocMetadata { id: string; title: string; description: string; audience: 'human' | 'agent' | 'technical' | 'planning'; filename: string }
export interface ProductDoc extends DocMetadata { content: string }
export { listPublicDocs as listDocs, readPublicDoc as readDoc } from './distribution';
