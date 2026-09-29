'use strict';

// Kept verbatim from the requested brief; only the action placeholder changes.
function buildPrompt(action) {
  if (typeof action !== 'string' || !action.trim()) throw new Error('Harakat promptini kiriting.');
  if (action.length > 8000) throw new Error('Prompt 8000 belgidan oshmasin.');
  return `Maintain absolute character and environmental consistency based strictly on the reference image provided.
Action to perform: ${action.trim()}

CRITICAL RESTRICTIONS:
1. FACIAL & BODY IDENTITY: Preserve the exact facial features, bone structure, expression base, skin tone, hair texture, and body proportions of the person in the reference image. Do NOT alter, stylize, or re-imagine their identity.
2. APPAREL & BRANDING: Keep all clothing items, colors, fabrics, and patterns identical. All branding elements, corporate logos, text graphics, and labels must remain completely sharp, unaltered, and intact. Do NOT distort, smudge, or redesign any logos.
3. ENVIRONMENT & BACKGROUND: Maintain the exact spatial geometry, background elements, lighting conditions, and ambient objects from the reference image. Only animate what is explicitly requested in the prompt.
4. GENERATION STYLE: Execute the motion seamlessly using the reference as the absolute first frame (Image-to-Video). The generation must look like a natural continuation of the source media, preventing any visual flickering, warping, or unexpected transformations.`;
}
module.exports = { buildPrompt };
