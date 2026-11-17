import { APPLICATION_NAME } from "../../../shared/branding";
import logoUrl from "../assets/xiaozhan-logo.png";

type BrandLogoProps = {
  className?: string;
  decorative?: boolean;
};

export function BrandLogo({ className, decorative = false }: BrandLogoProps) {
  return (
    <img className={className} src={logoUrl} alt={decorative ? "" : `${APPLICATION_NAME} Logo`} />
  );
}
