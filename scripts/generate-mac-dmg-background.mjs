import sharp from "sharp";

await sharp("build/dmg-background.svg").png().toFile("build/dmg-background@2x.png");
