// Run: gjs -m extension/tests/systemFont.test.js
import {fontCss} from '../systemFont.js';

let failures = 0;
function eq(name, got, want) {
    if (got === want) {
        print(`PASS ${name}`);
    } else {
        failures++;
        print(`FAIL ${name}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
    }
}

eq('family, weight and size', fontCss('Ubuntu Medium 11'), "font-family: 'Ubuntu'; font-weight: 500; font-size: 11pt;");
eq('regular', fontCss('Adwaita Sans 11'), "font-family: 'Adwaita Sans'; font-weight: 400; font-size: 11pt;");
eq('bold italic, half sizes', fontCss('Inter Bold Italic 10.5'), "font-family: 'Inter'; font-weight: 700; font-style: italic; font-size: 10.5pt;");
eq('first family of a list', fontCss('Cantarell, Sans 12'), "font-family: 'Cantarell'; font-weight: 400; font-size: 12pt;");
eq('no size', fontCss('Cantarell'), "font-family: 'Cantarell'; font-weight: 400;");
eq('quotes cannot leave the declaration', fontCss("Evil'; color: red 11").includes("';  color") , false);
eq('empty', fontCss(''), '');
eq('absurd size is left to the theme', fontCss('Sans 400'), "font-family: 'Sans'; font-weight: 400;");

print(failures ? `${failures} failure(s)` : 'all passed');
if (failures)
    imports.system.exit(1);
