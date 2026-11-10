export type ActivityKind =
  | 'appointment'
  | 'care-plan'
  | 'message'
  | 'check-in'
  | 'investigation'
  | 'procedure'
  | 'follow-up';
export interface ActivityContent {
  kind: ActivityKind;
  title: string;
  detail: string;
  href: string;
}
export interface ActivityItem extends ActivityContent {
  id: string;
  createdAt: string;
  readAt: string | null;
}
export interface ActivityFeed {
  items: ActivityItem[];
  unreadCount: number;
  nextCursor: string | null;
}
