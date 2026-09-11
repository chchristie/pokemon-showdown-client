export function packTeamSyntax(text: string) {
	const sets = text.trim().split(/\n\s*\n/).map(block => {
		const lines = block.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
		if (!lines.length) return null;
		const first = lines.shift()!;
		const match = /^(.*?)\s*(?:\(([^)]+)\))?\s*(?:@\s*(.+))?$/.exec(first);
		if (!match) return null;
		const name = match[1].trim();
		const species = (match[2] || name).trim();
		const item = (match[3] || '').trim();
		let ability = '';
		let nature = '';
		let level = '';
		let gender = '';
		let shiny = '';
		let happiness = '';
		let evs = '';
		let ivs = '';
		let teraType = '';
		const moves: string[] = [];
		for (const line of lines) {
			if (line.startsWith('Ability:')) ability = line.slice(8).trim();
			else if (line.startsWith('Level:')) level = line.slice(6).trim();
			else if (line.startsWith('Gender:')) gender = line.slice(7).trim();
			else if (line === 'Shiny: Yes') shiny = 'S';
			else if (line.startsWith('Happiness:')) happiness = line.slice(10).trim();
			else if (line.startsWith('EVs:')) evs = packStats(line.slice(4));
			else if (line.startsWith('IVs:')) ivs = packStats(line.slice(4));
			else if (line.startsWith('Tera Type:')) teraType = packName(line.slice(10).trim());
			else if (line.endsWith(' Nature')) nature = line.slice(0, -7).trim();
			else if (line.startsWith('- ')) moves.push(packName(line.slice(2).trim()));
		}
		const extra = teraType ? `,${teraType}` : '';
		return `${packName(name)}|${packName(species)}|${packName(item)}|${packName(ability)}|${moves.join(',')}|${nature}|${evs}|${gender}|${ivs}|${shiny}|${level}|${happiness}${extra}`;
	}).filter(Boolean);
	return sets.join(']');
}

function packStats(value: string) {
	const stats: { [key: string]: string } = {};
	for (const part of value.split('/')) {
		const match = /([0-9]+)\s+(.+)/.exec(part.trim());
		if (match) {
			stats[match[2].toLowerCase()
				.replace('special attack', 'spa').replace('special defense', 'spd')
				.replace('attack', 'atk').replace('defense', 'def').replace('speed', 'spe').replace('hp', 'hp')] = match[1];
		}
	}
	return ['hp', 'atk', 'def', 'spa', 'spd', 'spe'].map(stat => stats[stat] || '').join(',');
}

function packName(value: string) {
	return value.replace(/[^A-Za-z0-9]+/g, '');
}
