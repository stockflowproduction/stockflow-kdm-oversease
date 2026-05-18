import { GoogleGenAI } from "@google/genai";

// Always initialize the Google GenAI client with process.env.API_KEY as per guidelines.
const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });

/**
 * Generates a catchy product description using Gemini 3 Flash.
 */
export const generateProductDescription = async (name: string, category: string): Promise<string> => {
  try {
    const response = await ai.models.generateContent({
      model: 'gemini-3-flash-preview',
      contents: `Write a short, catchy, professional product description (max 2 sentences) for a product named "${name}" in the category "${category}".`,
    });
    // Use .text property directly (not a method).
    return response.text || "No description generated.";
  } catch (error) {
    return "Failed to generate description. Please try again.";
  }
};

/**
 * Analyzes sales transactions and provides insights using Gemini 3 Flash.
 */
export const analyzeSales = async (transactions: any[]): Promise<string> => {
  try {
    const summary = JSON.stringify(transactions.slice(0, 20)); // Limit context
    const response = await ai.models.generateContent({
      model: 'gemini-3-flash-preview',
      contents: `Analyze these recent sales transactions and give me 3 bullet points on sales trends or advice for the shop owner. Data: ${summary}`,
    });
    // Use .text property directly (not a method).
    return response.text || "No insights available.";
  } catch (error) {
    return "Failed to analyze data.";
  }
};