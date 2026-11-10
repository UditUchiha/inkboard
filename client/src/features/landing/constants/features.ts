import {
  GitPullRequestArrow,
  GraduationCap,
  History,
  MessageSquare,
  Pencil,
  Presentation,
  Share2,
  Sigma,
  Sparkles,
  Users,
  Vote,
  Workflow,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";

export type Feature = { icon: LucideIcon; title: string; body: string };

export const FEATURES: Feature[] = [
  {
    icon: Pencil,
    title: "Hand-drawn or clean",
    body: "Shapes start out sketchy so ideas look unfinished on purpose. Switch any of them to crisp lines when they're ready.",
  },
  {
    icon: Users,
    title: "See who's drawing",
    body: "Everyone gets a named cursor. Click an avatar and your view follows theirs, so a walkthrough lands where they point.",
  },
  {
    icon: Sparkles,
    title: "Describe it, get a diagram",
    body: "Type what you want and an AI draws it on the board. Bring your own key from Anthropic, OpenAI, Gemini, OpenRouter or Groq; it never leaves your browser.",
  },
  {
    icon: Sigma,
    title: "Handwriting to equations",
    body: "Scribble a formula with the pen and turn it into typeset LaTeX in one click.",
  },
  {
    icon: Workflow,
    title: "Mermaid in and out",
    body: "Paste Mermaid text to get a laid-out diagram, and export any flowchart back as Mermaid.",
  },
  {
    icon: GraduationCap,
    title: "Classroom mode",
    body: "Each student gets their own frame to work in while the teacher watches all of them and copies a frame to the whole class.",
  },
  {
    icon: Presentation,
    title: "Present from frames",
    body: "Frames become slides. Step through them full screen with a laser pointer while everyone follows along.",
  },
  {
    icon: GitPullRequestArrow,
    title: "Suggest mode",
    body: "Share a link that lets people propose changes instead of making them. Accept or reject each suggestion.",
  },
  {
    icon: MessageSquare,
    title: "Comments and mentions",
    body: "Pin a comment to any spot on the board, @mention a teammate, react, and resolve threads when they're done.",
  },
  {
    icon: History,
    title: "History and replay",
    body: "Boards are checkpointed as you work. Name a version, restore an old one, or replay how the board was drawn.",
  },
  {
    icon: Vote,
    title: "Vote and time-box",
    body: "Dot voting on anything on the board and a shared timer, for retros and workshops that need to end on time.",
  },
  {
    icon: Share2,
    title: "Share by link, embed or API",
    body: "View, edit or suggest links with optional passwords and expiry, a live embed for any page, and a REST API with tokens.",
  },
];

export const STEPS = [
  { title: "Start drawing", body: "No account needed. The board is kept in your browser until you decide to save it." },
  { title: "Share the link", body: "Anyone with it joins in seconds. Guests can draw without signing up." },
  {
    title: "It stays in sync",
    body: "Every stroke is saved and sent live. Close the tab and come back to the same board.",
  },
];
