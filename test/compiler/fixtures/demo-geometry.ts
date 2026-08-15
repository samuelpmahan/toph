export interface Component {
	area: number;
	aspect: number;
}

export const components: Component[] = [
	{ area: 200, aspect: 1.2 },
	{ area: 50, aspect: 1.5 },
	{ area: 300, aspect: 4.0 },
];

export const minArea = 100;
export const maxAspect = 2.0;

/** @toph filter demo.geometry */
const survivors = components.filter((component) => {
	/** @toph check area.min unit=px2 */
	const areaOk = component.area >= minArea;
	if (!areaOk) return false;
	/** @toph check aspect.max */
	const aspectOk = component.aspect <= maxAspect;
	if (!aspectOk) return false;
	return true;
});

export { survivors };
