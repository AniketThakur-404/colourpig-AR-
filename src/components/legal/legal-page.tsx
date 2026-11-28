import React from "react";
import Link from "next/link";
import { Navbar } from "@/components/navigation/navbar";
import { CartDrawer } from "@/components/cart/cart-drawer";
import { WishlistDrawer } from "@/components/wishlist/wishlist-drawer";
import { HamburgerMenu } from "@/components/navigation/hamburger-menu";
import { EcommFooter } from "@/components/home/ecomm-footer";
import { StoreProvider } from "@/context/store-context";
import { CONTACT_EMAIL, LEGAL_PAGES, LegalPageHref } from "@/data/legal";

export { CONTACT_EMAIL };

/**
 * Shell for the policy pages: site navigation, a plain reading column, and the
 * footer. Policy text is passed as children using h2, p, ul and a elements.
 */
export function LegalPage({
  title,
  updated,
  current,
  children,
}: {
  title: string;
  /** Shown under the title, e.g. "17 November 2026" */
  updated: string;
  /** href of this page, so it is marked in the page switcher */
  current: LegalPageHref;
  children: React.ReactNode;
}) {
  return (
    <StoreProvider>
      <div className="min-h-screen w-full bg-white text-obsidian flex flex-col overflow-x-clip selection:bg-steel selection:text-white">
        <CartDrawer />
        <WishlistDrawer />
        <HamburgerMenu />
        <Navbar />

        <main className="flex-1 pt-[128px] sm:pt-[168px] pb-20 sm:pb-28 px-4 sm:px-8">
          <article className="mx-auto w-full max-w-2xl">
            <h1 className="font-headline uppercase tracking-tight text-3xl sm:text-5xl leading-[1.05] text-obsidian">
              {title}
            </h1>
            <p className="mt-4 font-mono text-[11px] tracking-wider uppercase text-graphite">
              Last updated {updated}
            </p>

            <nav aria-label="Policies" className="mt-8 flex flex-wrap gap-2 border-b border-platinum pb-8">
              {LEGAL_PAGES.map((page) => {
                const active = page.href === current;
                return (
                  <Link
                    key={page.href}
                    href={page.href}
                    aria-current={active ? "page" : undefined}
                    className={`rounded-full border px-3.5 py-1.5 font-mono text-[11px] tracking-wider uppercase transition-colors ${
                      active
                        ? "border-obsidian bg-obsidian text-white"
                        : "border-platinum text-graphite hover:border-obsidian hover:text-obsidian"
                    }`}
                  >
                    {page.label}
                  </Link>
                );
              })}
            </nav>

            <div
              className="mt-10 text-[15px] leading-relaxed text-steel
                [&_h2]:mt-10 [&_h2]:mb-3 [&_h2]:font-headline [&_h2]:text-lg [&_h2]:sm:text-xl [&_h2]:uppercase [&_h2]:tracking-tight [&_h2]:text-obsidian
                [&_h2:first-child]:mt-0
                [&_p]:mb-4
                [&_ul]:mb-4 [&_ul]:list-disc [&_ul]:pl-5 [&_li]:mb-1.5 [&_li]:marker:text-ash
                [&_a]:text-obsidian [&_a]:underline [&_a]:underline-offset-2 hover:[&_a]:text-black
                [&_strong]:font-medium [&_strong]:text-obsidian"
            >
              {children}
            </div>

            <p className="mt-12 border-t border-platinum pt-6 text-sm text-graphite">
              Questions about this policy? Email{" "}
              <a href={`mailto:${CONTACT_EMAIL}`} className="text-obsidian underline underline-offset-2">
                {CONTACT_EMAIL}
              </a>
              .
            </p>
          </article>
        </main>

        <EcommFooter />
      </div>
    </StoreProvider>
  );
}
