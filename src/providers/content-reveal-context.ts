import { createContext } from "react";
import { type ContentReveals } from "../runtime/content-reveal";

export const ContentRevealContext = createContext<ContentReveals | null>(null);
