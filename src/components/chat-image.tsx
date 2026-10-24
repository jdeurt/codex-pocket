"use client";
import { Attachment, AttachmentMedia, AttachmentTrigger } from "@/components/ui/attachment";
import {
  Drawer,
  DrawerClose,
  DrawerContent,
  DrawerDescription,
  DrawerTitle,
  DrawerTrigger,
} from "@/components/ui/drawer";
import { imageUrl, thumbnailUrl } from "@/lib/images";
import { Button } from "@/components/ui/button";
import Image from "next/image";
import { Skeleton } from "@/components/ui/skeleton";
import { XIcon } from "lucide-react";
import { scopedPocketUrl } from "../state/pocket";
import { usePocketId } from "../providers/pocket-navigation-context";
import { imageFailed } from "../runtime/image-events";
import { useState } from "react";

const IMAGE_WIDTH = 1200;
const IMAGE_HEIGHT = 900;

/**
Display a guarded image and its native preview drawer with loading and failure states.
@param props - Normalized source and optional accessible image description.
@returns The image attachment and existing preview composition.
*/
export function ChatImage({ source, alt = "Image from Pocket" }: { source: string; alt?: string }) {
  const pocketId = usePocketId();
  const [loaded, setLoaded] = useState(false);
  const [failed, setFailed] = useState(false);
  const src = imageUrl(source);

  if (!src) {
    return <span className="image-error">This image source is unavailable.</span>;
  }

  return (
    <Drawer swipeDirection="down">
      <Attachment className="chat-image" variant="image" size="image" state={failed ? "error" : "done"}>
        <AttachmentMedia className="chat-image-media" variant="preview">
          {!loaded && !failed && <Skeleton className="image-placeholder" />}
          {failed ? (
            <span className="image-error">Image unavailable</span>
          ) : (
            <Image
              unoptimized
              draggable={false}
              src={src.startsWith("/api/") ? scopedPocketUrl(pocketId, thumbnailUrl(src)) : thumbnailUrl(src)}
              alt={alt}
              width={IMAGE_WIDTH}
              height={IMAGE_HEIGHT}
              loading="eager"
              decoding="async"
              referrerPolicy="no-referrer"
              onLoad={setLoaded.bind(undefined, true)}
              onError={imageFailed.bind(undefined, setFailed, src)}
            />
          )}
        </AttachmentMedia>
        {!failed && <DrawerTrigger render={<AttachmentTrigger aria-label={`Preview image: ${alt}`} />} />}
      </Attachment>
      <DrawerContent className="image-preview" variant="image">
        <DrawerTitle className="sr-only">{alt}</DrawerTitle>
        <DrawerDescription className="sr-only">Full image preview, scaled to fit your screen.</DrawerDescription>
        <div className="image-preview-toolbar" data-base-ui-swipe-ignore>
          <DrawerClose render={<Button variant="ghost" size="icon-xl" aria-label="Close image preview" />}>
            <XIcon />
          </DrawerClose>
        </div>
        <div className="image-preview-stage">
          <div className="image-fit-stage">
            <Image
              unoptimized
              draggable={false}
              src={src.startsWith("/api/") ? scopedPocketUrl(pocketId, src) : src}
              alt={alt}
              width={IMAGE_WIDTH}
              height={IMAGE_HEIGHT}
              referrerPolicy="no-referrer"
            />
          </div>
        </div>
      </DrawerContent>
    </Drawer>
  );
}
