import { FilesetResolver, HandLandmarker } from './vendor/vision_bundle.mjs';
export async function createDetector(){
  const dir=new URL('./',import.meta.url);
  const files=await FilesetResolver.forVisionTasks(new URL('vendor/wasm',dir).href);
  return HandLandmarker.createFromOptions(files,{
    baseOptions:{modelAssetPath:new URL('hand_landmarker.task',dir).href,delegate:'CPU'},
    runningMode:'VIDEO',numHands:1,minHandDetectionConfidence:.60,minHandPresenceConfidence:.58,minTrackingConfidence:.58
  });
}
