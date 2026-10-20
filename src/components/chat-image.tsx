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
import { reportClient } from "@/lib/client-logging";
import { useState } from "react";

const IMAGE_WIDTH = 1200;
const IMAGE_HEIGHT = 900;

export function ChatImage({ source, alt = "Image from Pocket" }: { source: string; alt?: string }) {
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
              src={thumbnailUrl(src)}
              alt={alt}
              width={IMAGE_WIDTH}
              height={IMAGE_HEIGHT}
              loading="eager"
              decoding="async"
              referrerPolicy="no-referrer"
              onLoad={() => {
                setLoaded(true);
              }}
              onError={() => {
                setFailed(true);
                reportClient("image.failed", { source: src.startsWith("data:") ? "inline image" : src }, "error");
              }}
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
              src={src}
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
