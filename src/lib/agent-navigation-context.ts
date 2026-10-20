import { createContext } from "react";

export const AgentNavigationContext = createContext<((id: string, trigger: HTMLButtonElement) => void) | null>(null);
