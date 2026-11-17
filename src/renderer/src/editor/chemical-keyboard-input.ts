const VALID_ELEMENTS = new Set(
  "H He Li Be B C N O F Ne Na Mg Al Si P S Cl Ar K Ca Sc Ti V Cr Mn Fe Co Ni Cu Zn Ga Ge As Se Br Kr Rb Sr Y Zr Nb Mo Tc Ru Rh Pd Ag Cd In Sn Sb Te I Xe Cs Ba La Ce Pr Nd Pm Sm Eu Gd Tb Dy Ho Er Tm Yb Lu Hf Ta W Re Os Ir Pt Au Hg Tl Pb Bi Po At Rn Fr Ra Ac Th Pa U Np Pu Am Cm Bk Cf Es Fm Md No Lr Rf Db Sg Bh Hs Mt Ds Rg Cn Nh Fl Mc Lv Ts Og".split(
    " ",
  ),
);

export type ChemicalPhysicalKey = {
  code: string;
  ctrlKey?: boolean;
  metaKey?: boolean;
  altKey?: boolean;
};

export type ChemicalLetterInsertionPlan = {
  latex: string;
  replacePrevious: boolean;
  ambiguousElement?: string;
};

export function isValidChemicalElementSymbol(symbol: string): boolean {
  return VALID_ELEMENTS.has(symbol);
}

export function getChemicalPhysicalLetter(event: ChemicalPhysicalKey): string | null {
  if (event.ctrlKey || event.metaKey || event.altKey) return null;
  const match = event.code.match(/^Key([A-Z])$/u);
  return match?.[1] ?? null;
}

export function planChemicalLetterInsertion(
  previousSymbol: string | null,
  letter: string,
): ChemicalLetterInsertionPlan {
  if (previousSymbol && /^[A-Z]$/u.test(previousSymbol)) {
    const pairedElement = `${previousSymbol}${letter.toLowerCase()}`;
    if (isValidChemicalElementSymbol(pairedElement)) {
      const separateElements =
        isValidChemicalElementSymbol(previousSymbol) && isValidChemicalElementSymbol(letter);
      if (!separateElements) {
        return { latex: pairedElement, replacePrevious: true };
      }
      return {
        latex: letter,
        replacePrevious: false,
        ambiguousElement: pairedElement,
      };
    }
  }

  return { latex: letter, replacePrevious: false };
}
