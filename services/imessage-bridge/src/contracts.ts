/**
 * Shared facts between the imessage-bridge service and the /imessage
 * management surface in the web app. The Linq line is account infrastructure
 * (one number per deployment), so it lives here rather than per-tenant data.
 */

export const ALBERT_IMESSAGE_BOT_NUMBER = "+16502831814" as const;

/** How the bot number reads on a phone keypad. */
export const ALBERT_IMESSAGE_BOT_NUMBER_DISPLAY = "+1 (650) 283-1814" as const;

/**
 * In group chats Albert answers only when addressed by name, so a busy group
 * thread is never flooded with analyses nobody asked for.
 */
export const ALBERT_IMESSAGE_GROUP_MENTION = /\balbert\b/iu;

export function mentionsAlbert(text: string): boolean {
  return ALBERT_IMESSAGE_GROUP_MENTION.test(text);
}

export function imessageIntroText(input: Readonly<{
  organisationName: string;
  displayName?: string | null;
}>): string {
  const greeting = input.displayName?.trim() ? `Hi ${input.displayName.trim()} - Albert here.` : "Albert here.";
  return [
    `${greeting} You've been enrolled for ${input.organisationName} insights over iMessage.`,
    "",
    "Text this number any question about the business - sales, margins, wages, cash - and I'll answer with live data.",
    "",
    "Try: How were sales last week?",
  ].join("\n");
}

export type ImessageEnrollment = Readonly<{
  enrollmentId: string;
  phone: string;
  displayName: string | null;
  email: string | null;
  isOwner: boolean;
  enabled: boolean;
  createdAt: string;
}>;

export type ImessageWorkspace = Readonly<{
  allowGroupChats: boolean;
  enrollments: readonly ImessageEnrollment[];
}>;
