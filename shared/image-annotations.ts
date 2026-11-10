export const annotationColors = ['red', 'amber', 'green', 'blue', 'purple', 'white'] as const;
export type AnnotationColor = (typeof annotationColors)[number];

interface MarkerDescription {
  id: string;
  color: AnnotationColor;
  label: string;
}

export type AnnotationMarker =
  | (MarkerDescription & {
      type: 'rectangle' | 'ellipse';
      x: number;
      y: number;
      width: number;
      height: number;
    })
  | (MarkerDescription & {
      type: 'arrow';
      x1: number;
      y1: number;
      x2: number;
      y2: number;
    });

export interface ImageAnnotationVersion {
  id: string;
  imageId: string;
  imageSha256: string;
  doctorId: string;
  doctorName: string;
  createdAt: string;
  note: string;
  markers: AnnotationMarker[];
  publishedAt: string | null;
  publishedByDoctorId: string | null;
  publishedByDoctorName: string | null;
}

export interface ImageAnnotationHistory {
  imageId: string;
  /** Present only for clinicians; patient responses always use null. */
  revision: string | null;
  versions: ImageAnnotationVersion[];
}
