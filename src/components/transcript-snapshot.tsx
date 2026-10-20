"use client";

import { Component, type ReactNode } from "react";
import type { ScrollSnapshot } from "@/lib/transcript-virtualization";
interface Props {
  suspended: boolean;
  children: ReactNode;
  capture: () => ScrollSnapshot | null;
  retain: (snapshot: ScrollSnapshot) => void;
}

// Layout effects run after an ancestor can become display:none. React's
// snapshot lifecycle reads the real offset before those DOM mutations.
export class TranscriptSnapshot extends Component<Props> {
  override getSnapshotBeforeUpdate(previous: Props) {
    return !previous.suspended && this.props.suspended ? this.props.capture() : null;
  }

  override componentDidUpdate(_previous: Props, _state: unknown, snapshot: ScrollSnapshot | null) {
    if (snapshot) {
      this.props.retain(snapshot);
    }
  }

  override render() {
    return this.props.children;
  }
}
