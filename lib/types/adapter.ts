import { Reactions } from '../reactions';
import type { ProxiedIdentity } from '../proxied';

export interface IUser {
  avatarUrl: string;
  login: string;
  url: string;
}

export type IReactionGroups = {
  [key in keyof typeof Reactions]: {
    count: number;
    viewerHasReacted: boolean;
  };
};

type ICommentAuthorAssociation =
  | 'COLLABORATOR'
  | 'CONTRIBUTOR'
  | 'FIRST_TIMER'
  | 'FIRST_TIME_CONTRIBUTOR'
  | 'MANNEQUIN'
  | 'MEMBER'
  | 'NONE'
  | 'OWNER'
  | 'APP';

interface IBaseComment {
  id: string;
  author: IUser;
  viewerDidAuthor: boolean;
  createdAt: string;
  url: string;
  authorAssociation: ICommentAuthorAssociation;
  lastEditedAt: string | null;
  deletedAt: string | null;
  isMinimized: boolean;
  bodyHTML: string;
  /** 原始 markdown（代发身份标记在里面，见 lib/proxied.ts）。 */
  body: string;
  /** 站方机器人代发的身份；普通 GitHub 评论为 null。 */
  proxied: ProxiedIdentity | null;
  reactions: IReactionGroups;
}

export interface IReply extends IBaseComment {
  replyToId: string;
}

export interface IComment extends IBaseComment {
  upvoteCount: number;
  viewerHasUpvoted: boolean;
  viewerCanUpvote: boolean;
  replyCount: number;
  replies: IReply[];
}

export interface IGiscussion {
  viewer: IUser;
  discussion: {
    id: string;
    url: string;
    locked: boolean;
    totalCommentCount: number;
    totalReplyCount: number;
    pageInfo: {
      startCursor: string;
      hasNextPage: boolean;
      hasPreviousPage: boolean;
      endCursor: string;
    };
    repository: {
      nameWithOwner: string;
    };
    reactionCount: number;
    reactions: IReactionGroups;
    comments: IComment[];
  };
}

export interface ICategory {
  id: string;
  name: string;
  emoji: string;
}

export interface ICategories {
  repositoryId: string;
  categories: ICategory[];
}

export interface IError {
  error: string;
}
