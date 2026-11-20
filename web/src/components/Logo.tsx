/** The Ukiyo seal: a breaking wave (a price path) under a rising sun, carved into a vermilion hanko. */
export function Logo({ size = 32, title = "Ukiyo" }: { size?: number; title?: string }) {
  const wave = "M7 50 C19 50 27 44 33 33 C37 25 44 19 51 22 C57 25 56 33 50 34 C46 35 44 31 47 29";
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" role="img" aria-label={title}>
      <rect x="2" y="2" width="60" height="60" rx="12" fill="#C8381E" />
      <circle cx="21" cy="21" r="9.5" fill="#F4EBDC" />
      <path d={wave} fill="none" stroke="#C8381E" strokeWidth="10" strokeLinecap="round" strokeLinejoin="round" />
      <path d={wave} fill="none" stroke="#F4EBDC" strokeWidth="4.5" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M30 56 C38 56 46 52 56 44" fill="none" stroke="#F4EBDC" strokeWidth="3" strokeLinecap="round" opacity="0.8" />
    </svg>
  );
}
