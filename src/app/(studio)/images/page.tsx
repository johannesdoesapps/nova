import type { Metadata } from "next";
import { ImagesPage } from "@/components/studio/images-page";

export const metadata: Metadata = { title: "Images", description: "Create an image from a description." };

export default function Images() {
  return <ImagesPage />;
}
