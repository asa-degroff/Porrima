import { Type } from '@sinclair/typebox';
import { getBlueskyAgent } from './bluesky-agent.js';
import { BlueskyNotification } from '../types.js';

/**
 * Bluesky tool definitions for the agent tool registry.
 * These tools allow the agent to interact with Bluesky.
 */

// -----------------------------------------------------------------------------
// Tool Schemas (TypeBox)
// -----------------------------------------------------------------------------

export const BlueskyListNotificationsSchema = Type.Object({
  limit: Type.Optional(Type.Number({ description: 'Max notifications to return (default: 50)' })),
  reasons: Type.Optional(Type.Array(Type.String(), { description: 'Filter by reason: mention, reply, follow, like, repost' })),
});

export const BlueskyGetThreadSchema = Type.Object({
  uri: Type.String({ description: 'AT Protocol URI of the post (at://...)' }),
  parentHeight: Type.Optional(Type.Number({ description: 'Number of parent posts to fetch (default: 80)' })),
  depth: Type.Optional(Type.Number({ description: 'Reply depth (default: 25)' })),
});

export const BlueskyReplySchema = Type.Object({
  uri: Type.String({ description: 'AT Protocol URI of the post to reply to' }),
  cid: Type.String({ description: 'Content ID of the post to reply to' }),
  text: Type.Union([
    Type.String({ description: 'Reply text (max 300 chars)' }),
    Type.Array(Type.String(), { description: 'Array of reply texts for threaded replies' }),
  ]),
  lang: Type.Optional(Type.String({ description: 'Language code (default: en-US)' })),
  rootUri: Type.Optional(Type.String({ description: 'Root post URI (auto-detected if not provided)' })),
  rootCid: Type.Optional(Type.String({ description: 'Root post CID (auto-detected if not provided)' })),
});

export const BlueskyPostSchema = Type.Object({
  text: Type.String({ description: 'Post text (max 300 chars)' }),
  lang: Type.Optional(Type.String({ description: 'Language code (default: en-US)' })),
});

export const BlueskyResolveHandleSchema = Type.Object({
  handle: Type.String({ description: 'Bluesky handle (e.g., user.bsky.social)' }),
});

export const BlueskyGetProfileSchema = Type.Object({
  actor: Type.String({ description: 'DID or handle of the user' }),
});

export const BlueskyLikeSchema = Type.Object({
  uri: Type.String({ description: 'AT Protocol URI of the post to like' }),
  cid: Type.String({ description: 'Content ID of the post to like' }),
});

export const BlueskyRepostSchema = Type.Object({
  uri: Type.String({ description: 'AT Protocol URI of the post to repost' }),
  cid: Type.String({ description: 'Content ID of the post to repost' }),
});

export const BlueskyFollowSchema = Type.Object({
  did: Type.String({ description: 'DID of the user to follow' }),
});

// -----------------------------------------------------------------------------
// Tool Execution Handlers
// -----------------------------------------------------------------------------

export async function executeBlueskyTool(name: string, args: any): Promise<string> {
  const agent = getBlueskyAgent();
  
  if (!agent.isAuthenticated()) {
    return 'Error: Bluesky not authenticated. Please configure credentials in settings first.';
  }

  try {
    switch (name) {
      case 'bluesky_list_notifications': {
        const notifications = await agent.listNotifications({
          limit: args.limit ?? 50,
          reasons: args.reasons,
        });
        
        if (notifications.length === 0) {
          return 'No new notifications.';
        }

        // Format notifications for the agent
        const formatted = notifications.map((n, i) => {
          const author = n.author as any;
          const record = n.record as any;
          return `[${i + 1}] @${author.handle} (${n.reason})\n` +
            `    Text: "${record.text ?? '(no text)'}"\n` +
            `    URI: ${n.uri}\n` +
            `    Indexed: ${n.indexedAt}`;
        }).join('\n\n');

        return `Found ${notifications.length} notification(s):\n\n${formatted}`;
      }

      case 'bluesky_get_thread': {
        const thread = await agent.getPostThread(args.uri, {
          parentHeight: args.parentHeight ?? 80,
          depth: args.depth ?? 25,
        });

        // Flatten thread for display
        const posts = flattenThread(thread.thread);
        const formatted = posts.map((p: any, i: number) => {
          return `[${i + 1}] @${p.author.handle}\n` +
            `    "${p.record.text}"\n` +
            `    URI: ${p.uri}\n` +
            `    Posted: ${p.record.createdAt}`;
        }).join('\n\n');

        return `Thread with ${posts.length} post(s):\n\n${formatted}`;
      }

      case 'bluesky_reply': {
        const results = await agent.replyToPost({
          uri: args.uri,
          cid: args.cid,
          text: args.text,
          lang: args.lang ?? 'en-US',
          rootUri: args.rootUri,
          rootCid: args.rootCid,
        });

        if (results.length === 1) {
          return `Reply posted successfully: ${results[0].uri}`;
        } else {
          return `Thread posted successfully (${results.length} posts):\n` +
            results.map((r, i) => `  ${i + 1}. ${r.uri}`).join('\n');
        }
      }

      case 'bluesky_post': {
        const result = await agent.createPost({
          text: args.text,
          lang: args.lang ?? 'en-US',
        });
        return `Post created: ${result.uri}`;
      }

      case 'bluesky_resolve_handle': {
        const did = await agent.resolveHandle(args.handle);
        return `@${args.handle} → ${did}`;
      }

      case 'bluesky_get_profile': {
        const profile = await agent.getProfile(args.actor);
        return `@${profile.handle}\n` +
          `Display: ${profile.displayName ?? '(none)'}\n` +
          `Followers: ${profile.followersCount} | Following: ${profile.followsCount}\n` +
          `Posts: ${profile.postsCount}\n` +
          `Bio: ${profile.description ?? '(none)'}`;
      }

      case 'bluesky_like': {
        const result = await agent.like(args.uri, args.cid);
        return `Liked post: ${result.uri}`;
      }

      case 'bluesky_repost': {
        const result = await agent.repost(args.uri, args.cid);
        return `Reposted: ${result.uri}`;
      }

      case 'bluesky_follow': {
        const result = await agent.follow(args.did);
        return `Followed user: ${result.uri}`;
      }

      default:
        return `Unknown Bluesky tool: ${name}`;
    }
  } catch (err: any) {
    return `Error: ${err.message ?? String(err)}`;
  }
}

// -----------------------------------------------------------------------------
// Helper Functions
// -----------------------------------------------------------------------------

/**
 * Flatten a thread structure into a list of posts.
 */
function flattenThread(threadNode: any): any[] {
  const posts: any[] = [];

  function traverse(node: any) {
    if (!node) return;

    // Parent first (chronological)
    if (node.parent) {
      traverse(node.parent);
    }

    // This post
    if (node.post) {
      posts.push(node.post);
    }

    // Replies
    if (node.replies) {
      for (const reply of node.replies) {
        traverse(reply);
      }
    }
  }

  traverse(threadNode);
  return posts;
}

// -----------------------------------------------------------------------------
// Tool Registry Export
// -----------------------------------------------------------------------------

export const BLUESKY_TOOLS = [
  {
    name: 'bluesky_list_notifications',
    description: 'List recent Bluesky notifications (mentions, replies, etc.)',
    schema: BlueskyListNotificationsSchema,
  },
  {
    name: 'bluesky_get_thread',
    description: 'Fetch full thread context for a post including parents and replies',
    schema: BlueskyGetThreadSchema,
  },
  {
    name: 'bluesky_reply',
    description: 'Reply to a Bluesky post. Use text array for multi-post threads.',
    schema: BlueskyReplySchema,
  },
  {
    name: 'bluesky_post',
    description: 'Create a new Bluesky post (not a reply)',
    schema: BlueskyPostSchema,
  },
  {
    name: 'bluesky_resolve_handle',
    description: 'Resolve a Bluesky handle to a DID',
    schema: BlueskyResolveHandleSchema,
  },
  {
    name: 'bluesky_get_profile',
    description: 'Get a user\'s Bluesky profile information',
    schema: BlueskyGetProfileSchema,
  },
  {
    name: 'bluesky_like',
    description: 'Like a Bluesky post',
    schema: BlueskyLikeSchema,
  },
  {
    name: 'bluesky_repost',
    description: 'Repost a Bluesky post',
    schema: BlueskyRepostSchema,
  },
  {
    name: 'bluesky_follow',
    description: 'Follow a Bluesky user',
    schema: BlueskyFollowSchema,
  },
];
