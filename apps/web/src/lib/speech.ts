/**
 * Dictation into the card's field with the browser's speech recognition, where there is one
 * (Chrome, Safari). Where there isn't, the mic button is hidden and the keyboard's own dictation
 * (iOS) still works in the field.
 */

interface Recognition {
	lang: string;
	interimResults: boolean;
	continuous: boolean;
	onresult: ((event: RecognitionEvent) => void) | null;
	onend: (() => void) | null;
	onerror: ((event: { error?: string }) => void) | null;
	start(): void;
	stop(): void;
}

interface RecognitionEvent {
	results: ArrayLike<ArrayLike<{ transcript: string }>>;
}

type RecognitionConstructor = new () => Recognition;

function recognitionConstructor(): RecognitionConstructor | null {
	const scope = globalThis as unknown as {
		SpeechRecognition?: RecognitionConstructor;
		webkitSpeechRecognition?: RecognitionConstructor;
	};
	return scope.SpeechRecognition ?? scope.webkitSpeechRecognition ?? null;
}

/**
 * Set once the browser says listening isn't allowed here (a home-screen app on iOS says
 * `service-not-allowed`): the mic stays hidden for the rest of the session.
 */
let refused = false;

/** Errors that mean "not here, not now", rather than "didn't catch that". */
export function isRefusal(error: string | undefined): boolean {
	return error === 'not-allowed' || error === 'service-not-allowed';
}

export function canDictate(): boolean {
	return !refused && recognitionConstructor() !== null;
}

/**
 * Starts listening. `onText` gets the whole transcript so far each time it changes; `onEnd` runs
 * once when listening stops, by `stop()`, silence or an error. Returns the stop function, or null
 * when the browser can't listen.
 */
export function dictate(onText: (text: string) => void, onEnd: () => void): (() => void) | null {
	const Recognition = recognitionConstructor();
	if (!Recognition) return null;
	const recognition = new Recognition();
	recognition.lang = navigator.language;
	recognition.interimResults = true;
	recognition.continuous = false;
	recognition.onresult = (event) => {
		onText(
			Array.from(event.results)
				.map((result) => result[0]?.transcript ?? '')
				.join('')
		);
	};
	let ended = false;
	const end = () => {
		if (ended) return;
		ended = true;
		onEnd();
	};
	recognition.onend = end;
	recognition.onerror = (event) => {
		if (isRefusal(event.error)) refused = true;
		end();
	};
	try {
		recognition.start();
	} catch {
		end();
		return null;
	}
	return () => recognition.stop();
}
