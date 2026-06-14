import "express-session";

declare module "express-session" {
  interface SessionData {
    authenticated: boolean;
    currentChallenge?: string;
    currentUserVerification?: "preferred" | "required";
  }
}
